import { Bot } from 'grammy';
import Groq from 'groq-sdk';
import moment from 'moment-timezone';
import fs from 'fs';
import path from 'path';
import { Arcade } from '@arcadeai/arcadejs';
import "dotenv/config";


const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ARCADE_API_KEY = process.env.ARCADE_API_KEY;
const ARCADE_BASE_URL = process.env.ARCADE_BASE_URL || "https://api.arcade.dev";
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';

if (!TELEGRAM_BOT_TOKEN || !GROQ_API_KEY || !ARCADE_API_KEY) {
  console.error("Missing required environment variables. Please set TELEGRAM_BOT_TOKEN, GROQ_API_KEY, and ARCADE_API_KEY");
  process.exit(1);
}


const bot = new Bot(TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: GROQ_API_KEY });
const arcade = new Arcade(
  {
    apiKey: ARCADE_API_KEY,
    baseURL: ARCADE_BASE_URL,
  }
);

interface CalendarEvent {
    summary: string;
    description?: string;
    start_time: string; // ISO formatted time
    end_time: string;   // ISO formatted time
    location?: string;
    visibility?: "default" | "public" | "private" | "confidential";
    attendee_emails: string[];
    calendar?: string;
}

interface Calendar {
    id: string;
    summary: string;
    description?: string;
    timeZone?: string;
}

interface CreateEventResponse {
    event: CalendarEvent;
}

interface ListCalendarResponse {
    calendars: Calendar[];
    next_page_token: string;
    num_calendars: number;
}

interface PendingEvents {
    events: CalendarEvent[];
    originalText: string;
    previousJSONProposal?: string;
    editHistory?: string;
}

interface ConnectedAccount {
    accountId: number;
    email?: string;
    calendars: Calendar[];
}


// Map of chatId to an array of connected accounts
const connectedAccounts = new Map<number, ConnectedAccount[]>();

// Map of chatId to an array of authenticated accounts
const pendingConnections: number[] = [];

// Map of chatId to pending events
const pendingEvents = new Map<number, PendingEvents>();

// New global maps for handling calendar enable/disable state
const disabledCalendars = new Map<number, { [accountId: number]: Set<string> }>();

// Disk-based caching for authenticated clients
const cacheDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const AUTH_CACHE_PATH = path.join(cacheDir, 'authCache.json');

function saveAuthCache() {
    let cacheData: any = {};
    for (const [chatId, accounts] of connectedAccounts.entries()) {
        cacheData[chatId] = {
            accounts: accounts.map(account => ({
                accountId: account.accountId,
                email: account.email,
                calendars: account.calendars,
            })),
            disabledCalendars: disabledCalendars.has(chatId)
                ? Object.fromEntries(
                    Object.entries(disabledCalendars.get(chatId)!).map(([acctId, set]) => [acctId, Array.from(set)])
                  )
                : {}
        };
    }
    try {
        fs.writeFileSync(AUTH_CACHE_PATH, JSON.stringify(cacheData, null, 2));
    } catch (error) {
        console.error("Failed to save auth cache:", error);
    }
}

function loadAuthCache() {
    if (fs.existsSync(AUTH_CACHE_PATH)) {
        try {
            let data = JSON.parse(fs.readFileSync(AUTH_CACHE_PATH, 'utf-8'));
            for (let chatId in data) {
                let chatData = data[chatId];
                let accountsList = chatData.accounts || [];
                let oauthAccountsList = accountsList.map((accountData: ConnectedAccount) => {
                    return {
                        accountId: accountData.accountId,
                        email: accountData.email,
                        calendars: accountData.calendars
                    };
                });
                connectedAccounts.set(parseInt(chatId, 10), oauthAccountsList);
                const disabledForChat: { [accountId: number]: Set<string> } = {};
                if (chatData.disabledCalendars) {
                    for (const acctId in chatData.disabledCalendars) {
                        const arr = chatData.disabledCalendars[acctId];
                        disabledForChat[parseInt(acctId)] = Array.isArray(arr) ? new Set(arr) : new Set();
                    }
                }
                disabledCalendars.set(parseInt(chatId, 10), disabledForChat);
            }
        } catch (error) {
            console.error("Failed to load auth cache:", error);
        }
    }
}

loadAuthCache();

function resolveCalendarId(chatId: number, accountId: number, calendarIdentifier: string, isStrict: boolean = true): { success: boolean, realCalendarId: string, errorMsg?: string } {
  const accounts = connectedAccounts.get(chatId);
  if (!accounts) {
    if (isStrict) {
      return { success: false, realCalendarId: '', errorMsg: "No authenticated accounts found." };
    } else {
      return { success: true, realCalendarId: calendarIdentifier };
    }
  }
  const account = accounts.find(acc => acc.accountId === accountId);
  if (!account) {
    if (isStrict) {
      return { success: false, realCalendarId: '', errorMsg: `Account ${accountId} not found.` };
    } else {
      return { success: true, realCalendarId: calendarIdentifier };
    }
  }
  let realCalendarId = calendarIdentifier;
  const calendarIndex = parseInt(calendarIdentifier);
  if (!isNaN(calendarIndex)) {
    if (isStrict && (calendarIndex < 1 || calendarIndex > account.calendars.length)) {
      return { success: false, realCalendarId: '', errorMsg: `Invalid calendar index. Please provide a number between 1 and ${account.calendars.length}.` };
    }
    if (!isStrict || (calendarIndex >= 1 && calendarIndex <= account.calendars.length)) {
      realCalendarId = account.calendars[calendarIndex - 1].id;
    }
  }
  return { success: true, realCalendarId };
}

function buildAccountsAndCalendarsMessage(accounts: ConnectedAccount[], chatId: number, showDisabled: boolean, enabledOnly: boolean = false): string {
  if (accounts.length === 0) return "No accounts connected.\n";
  let message = "";
  accounts.forEach(account => {
    const accountLabel = account.email ? `Account ${account.accountId} (${account.email})` : `Account ${account.accountId}`;
    message += `${accountLabel}:\n`;
    if (!account.calendars || account.calendars.length === 0) {
      message += "- No calendars found.\n";
    } else {
      account.calendars.forEach((cal, index) => {
        let disabled = false;
        const userDisabled = disabledCalendars.get(chatId);
        if (userDisabled && userDisabled[account.accountId] && userDisabled[account.accountId].has(cal.id)) {
          disabled = true;
        }
        // If only enabled calendars should be shown, skip disabled ones
        if (enabledOnly && disabled) return;
        let line = `- ${index + 1}. ${cal.summary} (ID: ${cal.id})`;
        if (showDisabled && disabled) {
          line += " (Disabled)";
        }
        message += line + "\n";
      });
    }
  });
  return message;
}

function formatEventsReply(events: CalendarEvent[], confirmMessage: string = "If these look good, type /confirm to add the events."): string {
  let reply = "Proposed events:";
  events.forEach((evt, index) => {
    reply += `\n\nEvent ${index + 1}:` +
             `\nTitle: ${evt.summary}` +
             `\nStart: ${evt.start_time}` +
             `\nEnd: ${evt.end_time}` +
             `\nDescription: ${evt.description}`;
  });
  reply += `\n\n` + confirmMessage;
  return reply;
}

async function fetchCalendars(chatId: number): Promise<Calendar[]> {
    if (connectedAccounts.has(chatId)){
        return connectedAccounts.get(chatId)?.[0].calendars || [];
    }

    const toolResponse = await arcade.tools.execute({
        tool_name: "Google.ListCalendars",
        input: {
            show_deleted: true,
            show_hidden: true,
        },
        user_id: chatId.toString(),
    });
    return (toolResponse.output?.value as ListCalendarResponse).calendars;
}


async function parseEventDescription(userText: string, chatId: number): Promise<{ events: CalendarEvent[], jsonProposal: string }> {
    const currentDate = moment().format('YYYY-MM-DD');
    const currentDay = moment().format('dddd');
    const accounts = connectedAccounts.get(chatId) || [];
    const accountInfo = buildAccountsAndCalendarsMessage(accounts, chatId, false, true);
    const pending = pendingEvents.get(chatId);
    const previousProposalText = pending && pending.previousJSONProposal ? `Previous JSON proposal: ${pending.previousJSONProposal}\n` : "";

    // Define the calendar event extraction tool
    const tools = [
        {
            type: "function" as const,
            function: {
                name: "extractCalendarEvents",
                description: "Extract calendar events from user text with proper formatting",
                parameters: {
                    type: "object",
                    properties: {
                        events: {
                            type: "array",
                            description: "Array of calendar events extracted from user text",
                            items: {
                                type: "object",
                                properties: {
                                    title: {
                                        type: "string",
                                        description: "Title of the event"
                                    },
                                    start_time: {
                                        type: "string",
                                        description: "Start time in ISO format"
                                    },
                                    end_time: {
                                        type: "string",
                                        description: "End time in ISO format"
                                    },
                                    description: {
                                        type: "string",
                                        description: "Description of the event"
                                    },
                                    accountId: {
                                        type: "number",
                                        description: "The account ID to use for this event"
                                    },
                                calendar: {
                                    type: "string",
                                    description: "Optional calendar ID, defaults to 'primary'"
                                }
                                },
                                required: ["title", "start_time", "end_time", "description", "accountId"]
                            }
                        }
                    },
                    required: ["events"]
                }
            }
        }
    ];

    // System message providing context
    const systemMessage = `
    You are an assistant that extracts calendar event details from natural language.
        Current Date: ${currentDate} (${currentDay})
    Available accounts and calendars:
        ${accountInfo}

    When extracting event information, follow these rules:
        1. If the time zone is not specified, assume the default timezone: ${DEFAULT_TIMEZONE}
    2. When a user proposes relative dates (e.g. next week on Wednesday), make sure your date math is correct (if today is Tuesday 18th, then next week on Wednesday is the 26th, 7 days would be Tuesday 25th + 1 for Wednesday 26th)
        3. If the user indicates time zone (can be an informal remark like 'in NYC time') then use the ISO notation where the times the user specifies are used directly (e.g. 2pm) in the ISO format, and the ISO timezone suffix aligns with what the user specifies
    4. For "calendar" field, if it cannot be inferred from the user query, default to "primary"
        5. For "calendar" field, other than "primary" you are ONLY allowed to choose calendar ID values listed under Available accounts and calendars

    ${previousProposalText}`;

    try {
        const modelPriorityOrder = [
            "qwen-qwq-32b",
            // "llama-3.3-70b-versatile",
            // "qwen-2.5-32b",
            // "deepseek-r1-distill-llama-70b-specdec",
            // "deepseek-r1-distill-llama-70b",
            // "deepseek-r1-distill-qwen-32b"
        ];

        let toolResponse: any = null;
        let lastError;

        for (const model of modelPriorityOrder) {
            try {
                const chatCompletion = await groq.chat.completions.create({
                    messages: [
                        { role: "system", content: systemMessage },
                        { role: "user", content: userText }
                    ],
                    temperature: 0.6,
                    top_p: 0.95,
                    model,
                    tools,
                    tool_choice: "auto"
                });

                const responseMessage = chatCompletion.choices[0]?.message;
                const toolCalls = responseMessage?.tool_calls;

                if (toolCalls && toolCalls.length > 0) {
                    const extractCall = toolCalls.find(call => call.function.name === "extractCalendarEvents");
                    if (extractCall) {
                        const functionArgs = JSON.parse(extractCall.function.arguments);
                        toolResponse = functionArgs;
                        break;
                    }
                }

                if (!toolResponse) {
                    throw new Error(`Model ${model} failed to use the extractCalendarEvents tool correctly`);
                }
            } catch (error) {
                console.error(`Error with model ${model}:`, error);
                lastError = error;
            }
        }

        if (!toolResponse) {
            throw lastError || new Error("All models failed to extract calendar events.");
        }

        const events = toolResponse.events.map( (event: any): CalendarEvent => {
            return {
                summary: event.title,
                start_time: event.start_time,
                end_time: event.end_time,
                description: event.description,
                attendee_emails: [],
                visibility: "default",
                calendar: event.calendar || "primary",
            };
        });
        const jsonProposal = JSON.stringify(events, null, 2);

        return { events, jsonProposal };
    } catch (error) {
        console.error("Error parsing event description:", error);
        throw error;
    }
}

async function addEventToCalendar(chatId: number, eventData: CalendarEvent) {

    const accounts = connectedAccounts.get(chatId);
    let connectedAccount: ConnectedAccount | undefined;
    // If not specified, default to the first account if available
    if (!connectedAccount && accounts && accounts.length > 0) {
        connectedAccount = accounts[0];
    }
    if (!connectedAccount) {
        bot.api.sendMessage(chatId, "No authenticated Google account found. Use /auth to authenticate.");
        return;
    }
    const calendarId = eventData.calendar || "primary";
    const userDisabled = disabledCalendars.get(chatId) || {};
    if (userDisabled[connectedAccount.accountId]?.has(calendarId)) {
        bot.api.sendMessage(chatId, `Calendar ${calendarId} for Account ${connectedAccount.accountId} is currently disabled. Skipping event: ${eventData.summary}`);
        return;
    }
    try {
        const toolResponse = await arcade.tools.execute({
            tool_name: "Google.CreateEvent",
            input: {
                calendar_id: calendarId,
                summary: eventData.summary,
                description: eventData.description,
                start_datetime: eventData.start_time,
                end_datetime: eventData.end_time,
                attendee_emails: eventData.attendee_emails,
                visibility: eventData.visibility,
            },
            user_id: chatId.toString(),
        });

        const createdEvent = (toolResponse.output?.value as CreateEventResponse).event;
        if (createdEvent) {
            bot.api.sendMessage(chatId, `Event added to calendar (${calendarId}): ${eventData.summary}`);
        } else {
            bot.api.sendMessage(chatId, "There was an error adding the event. Please try again.");
        }
    } catch (error) {
        console.error("Error adding event:", error);
        bot.api.sendMessage(chatId, "There was an error adding the event. Please try again.");
    }
}

const authArcade = async (chatId: number): Promise<{ logged_in: boolean, url: string }> => {
    const authResponse = await arcade.auth.start(
        chatId.toString(),
        "google",
        {
            scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/userinfo.email"],
        }
    )
    if (authResponse.status !== "completed") {
        return { logged_in: false, url: authResponse.url || "ERROR: No URL returned" };
    }
    return { logged_in: true, url: "" };
}

// Telegram Bot message handling
bot.on('message', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    if (!text) return;

    // /disable command handler
    if (text.startsWith('/disable')) {
        const args = text.slice('/disable'.length).trim();
        if (args.length === 0) {
            bot.api.sendMessage(chatId, "Invalid format. Please use: /disable <account_id> <calendar_id>");
            return;
        }
        const parts = args.split(' ').filter(x => x.trim().length > 0);
        if (parts.length < 2) {
            bot.api.sendMessage(chatId, "Invalid format. Please use: /disable <account_id> <calendar_id>");
            return;
        }
        const accountId = parseInt(parts[0]);
        if (isNaN(accountId)) {
            bot.api.sendMessage(chatId, "Invalid account id provided.");
            return;
        }
        const result = resolveCalendarId(chatId, accountId, parts[1], true);
        if (!result.success) {
            bot.api.sendMessage(chatId, result.errorMsg || "Error resolving calendar id");
            return;
        }
        const realCalendarId = result.realCalendarId;
        let userDisabled = disabledCalendars.get(chatId) || {};
        if (!userDisabled[accountId]) {
            userDisabled[accountId] = new Set();
        }
        userDisabled[accountId].add(realCalendarId);
        disabledCalendars.set(chatId, userDisabled);
        bot.api.sendMessage(chatId, `Calendar ${realCalendarId} for account ${accountId} has been disabled.`);
        saveAuthCache();
        return;
    }

    // /enable command handler
    if (text.startsWith('/enable')) {
        const args = text.slice('/enable'.length).trim();
        if (args.length === 0) {
            bot.api.sendMessage(chatId, "Invalid format. Please use: /enable <account_id> <calendar_id>");
            return;
        }
        const parts = args.split(' ').filter(x => x.trim().length > 0);
        if (parts.length < 2) {
            bot.api.sendMessage(chatId, "Invalid format. Please use: /enable <account_id> <calendar_id>");
            return;
        }
        const accountId = parseInt(parts[0]);
        if (isNaN(accountId)) {
            bot.api.sendMessage(chatId, "Invalid account id provided.");
            return;
        }
        const result = resolveCalendarId(chatId, accountId, parts[1], true);
        if (!result.success) {
            bot.api.sendMessage(chatId, result.errorMsg || "Error resolving calendar id");
            return;
        }
        const realCalendarId = result.realCalendarId;
        let userDisabled = disabledCalendars.get(chatId) || {};
        if (userDisabled[accountId] && userDisabled[accountId].has(realCalendarId)) {
            userDisabled[accountId].delete(realCalendarId);
            bot.api.sendMessage(chatId, `Calendar ${realCalendarId} for account ${accountId} has been enabled.`);
        } else {
            bot.api.sendMessage(chatId, `Calendar ${realCalendarId} for account ${accountId} is not disabled.`);
        }
        disabledCalendars.set(chatId, userDisabled);
        saveAuthCache();
        return;
    }

    // Start command
    if (text.startsWith('/start')) {
        bot.api.sendMessage(chatId, "Welcome! Send me a description of your calendar event and I'll help add it to your Google Calendar.\n\nCommands:\n/auth - Authenticate with Google Calendar\n/confirm - Confirm adding the proposed event(s)\n/edit <new description> - Edit the proposed event(s)");
        return;
    }

    // OAuth authentication command
    if (text.startsWith('/auth')) {
        if (!pendingConnections.includes(chatId)) {
            pendingConnections.push(chatId);
        }
        const authResponse = await authArcade(chatId);
        if (authResponse.logged_in) {
            if (pendingConnections.includes(chatId)) {
                pendingConnections.splice(pendingConnections.indexOf(chatId), 1);
            }
            const calendars = await fetchCalendars(chatId);
            if (!connectedAccounts.has(chatId)) {
                connectedAccounts.set(chatId, [{ accountId: 0, email: "", calendars }]);
            }
            const calendarList = calendars.map((c, i) => `\t${i}. ${c.id} - ${c.summary}`).join("\n");
            bot.api.sendMessage(chatId, "You're already authenticated with Google Calendar.\n\nCalendars:\n\n" + calendarList);
        } else {
            bot.api.sendMessage(chatId,`Please authenticate with Google Calendar by visiting this URL: ${authResponse.url}`);
        }
        return;
    }

    // /confirm command to add events
    if (text.startsWith('/confirm')) {
        const pending = pendingEvents.get(chatId);
        if (!pending) {
            bot.api.sendMessage(chatId, "No pending events. Send an event description first.");
            return;
        }
        bot.api.sendMessage(chatId, "Please confirm your events:", { reply_markup: { inline_keyboard: [[ { text: "Confirm", callback_data: "confirm" }, { text: "Edit", callback_data: "edit" } ]] } });
        return;
    }

    // Edit command to update the event description
    if (text.startsWith('/edit')) {
        const latestEdit = text.replace('/edit', '').trim();
        if (!latestEdit) {
            bot.api.sendMessage(chatId, "Please provide the update changes after the /edit command.");
            return;
        }
        const pending = pendingEvents.get(chatId);
        if (!pending) {
            bot.api.sendMessage(chatId, "No pending events available to edit. Please provide an event description first.");
            return;
        }
        const originalDescription = pending.originalText;
        const previousEdits = pending.editHistory || "";
        const newEditHistory = previousEdits ? previousEdits + "\n" + latestEdit : latestEdit;
        const combinedDescription = `Original description: ${originalDescription}\nUser requested changes:\nLatest edit: ${latestEdit}\n` +
            (previousEdits ? `Previously requested changes: ${previousEdits}\n` : "");
        try {
            const { events, jsonProposal } = await parseEventDescription(combinedDescription, chatId);
            let newPreviousJSONProposal = jsonProposal;
            if (pending.previousJSONProposal) {
                newPreviousJSONProposal = pending.previousJSONProposal + "\n" + jsonProposal;
            }
            pendingEvents.set(chatId, {
                events,
                originalText: originalDescription,
                previousJSONProposal: newPreviousJSONProposal,
                editHistory: newEditHistory
            });
            const reply = formatEventsReply(events, "If these look good, type /confirm to add the events.");
            bot.api.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[ { text: "Confirm", callback_data: "confirm" }, { text: "Edit", callback_data: "edit" } ]] } });
        } catch (error) {
            bot.api.sendMessage(chatId, "Error parsing updated event description. Please try again.");
        }
        return;
    }

    // Clear command to remove all authenticated accounts
    if (text.startsWith('/clear')) {
        connectedAccounts.delete(chatId);
        disabledCalendars.delete(chatId);
        saveAuthCache();
        bot.api.sendMessage(chatId, "All authenticated accounts have been cleared. Use /auth to authenticate again.");
        return;
    }

    if (text.startsWith('/calendars')) {
        const accounts = connectedAccounts.get(chatId);
        if (!accounts || accounts.length === 0) {
            bot.api.sendMessage(chatId, "No authenticated calendars found. Please use /auth to connect your Google Calendar.");
            return;
        }
        const args = text.slice('/calendars'.length).trim();
        if (args === "enabled") {
            const accountDetails = buildAccountsAndCalendarsMessage(accounts, chatId, true, true);
            const reply = "Enabled Calendars:\n" + accountDetails;
            bot.api.sendMessage(chatId, reply);
        } else {
            const accountDetails = buildAccountsAndCalendarsMessage(accounts, chatId, true, false);
            const reply = "Authenticated Calendars and Accounts:\n" + accountDetails;
            bot.api.sendMessage(chatId, reply);
        }
        return;
    }

    // If the message is a command we don't recognize
    if (text.startsWith('/')) {
        bot.api.sendMessage(chatId, "Unrecognized command. Please send an event description or use a valid command.");
        return;
    }

    // Otherwise, treat the message as a new event description
    try {
        pendingEvents.delete(chatId);
        const { events, jsonProposal } = await parseEventDescription(text, chatId);
        pendingEvents.set(chatId, { events, originalText: text, previousJSONProposal: jsonProposal, editHistory: "" });
        const reply = formatEventsReply(events, "If these look good, type /confirm to add the events, or /edit to modify.");
        bot.api.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[ { text: "Confirm", callback_data: "confirm" }, { text: "Edit", callback_data: "edit" } ]] } });
    } catch (error) {
        console.error(error);
        bot.api.sendMessage(chatId, "Error parsing event description. Please ensure your description is clear and try again.");
    }
});

bot.on('callback_query:data', async (ctx) => {
    const action = ctx.callbackQuery.data;
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    if (action === 'confirm') {
        const pending = pendingEvents.get(chatId);
        if (!pending) {
            bot.api.sendMessage(chatId, "No pending events to confirm.");
            return;
        }
        for (const eventData of pending.events) {
            await addEventToCalendar(chatId, eventData);
        }
        pendingEvents.delete(chatId);
        bot.api.sendMessage(chatId, "Events confirmed and added to your calendar.");
    } else if (action === 'edit') {
        bot.api.sendMessage(chatId, "Please send your updated event description using /edit command.");
    }
    await ctx.answerCallbackQuery();
});

// Main function for Railway deployment or local run
export async function main() {
    console.log("Telegram Calendar Bot is running...");
    bot.start();
}

main();
