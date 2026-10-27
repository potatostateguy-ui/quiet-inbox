# Quiet Inbox

A simple Windows email app for cleaning out spam and clutter. It's built to be easy for someone who isn't technical.

- **Mail**: read email like any other mail app.
  - Every email has a ☆ star and a ⋮ menu. The menu offers Delete (goes to Trash), Delete forever (frees space), Delete every email from this sender (to Trash or forever), Block this sender, Unsubscribe, Move to Spam, and Star.
  - **Select all** ticks every email shown. If there are more in the folder, a link offers **Select all 2,340 in Inbox**.
- **Clean up**: shows who is filling the mailbox, for **one account or several at once**. The account chips at the top choose which ones; "All accounts" is the default. Senders who email more than one account are merged into one row.
  - Tabs: Biggest senders, Never opened, Newsletters (one-click unsubscribe), Biggest emails, and Old emails ("delete everything older than 1, 2 or 5 years"), plus emails per month.
  - Every tab has a **select-all** box, and whatever is selected is deleted or blocked behind **one confirmation**, even across accounts.
- **Blocked**: senders or whole domains whose mail is deleted automatically.
- **System tray**: closing the window keeps Quiet Inbox running by the clock, so blocked senders keep being removed. By default it also starts quietly with Windows. Right-click the tray icon to open it, check now, change those two options, or quit.
- **Settings**: email accounts, text size, pictures on or off, colors, background running, and a history of what was deleted.

## How it keeps things safe

- **Starred emails are always kept.** Bulk deletes, "select all", old-email cleanup and blocked senders never touch them. The star is the normal IMAP flag, so it matches the star in Gmail and Yahoo and the flag in Outlook/MSN.
- **Dialogs only close from their own buttons**, never from a stray click outside.
- **Delete moves to Trash**, and the status bar offers **Undo** for 90 seconds.
- **"Forever" always asks first.** Anything that touches more than one email shows a count, size and folder breakdown before running.
- **Pictures in emails are blocked by default**, so spammers' tracking pixels can't confirm the address is active. Email is shown in a sandboxed frame with scripts disabled.
- **Links ask first** and show where they really go.
- **A red warning appears on fake senders.** It shows on emails that fail the sender checks (SPF, DKIM, DMARC); genuine senders show "Verified sender".
- **Passwords and sign-ins stay on the PC.** They are stored encrypted with Windows DPAPI.

## Build it (the easy way)

**Double-click `Build Quiet Inbox.bat`.** It does everything:

1. **Node.js:** installs it if it's missing or older than version 20, using winget or the official installer. Windows asks for permission once.
2. **Microsoft client ID:** asks you to paste it the first time, then saves it to `oauth.config.json`. Press Enter to skip if you don't need MSN or Outlook.
3. **Packages:** installs them. The first run takes a few minutes.
4. **Build:** creates the installer, then opens the `dist` folder with it selected.
5. **Optional:** offers to install Quiet Inbox on the PC you built it on.

Run it again any time you change something. It skips what's already done.

What you get in `dist\`:

- `Quiet Inbox Setup 1.0.0.exe`: the one for grandma. It installs with one double-click, adds desktop and Start menu shortcuts, and opens the app.
- `QuietInbox-Portable-1.0.0.exe`: runs without installing.

The build is unsigned, so the first time it runs Windows may say "Windows protected your PC". Choose **More info**, then **Run anyway**.

If the build fails, the window stays open with the reason. The full log is at `%TEMP%\quiet-inbox-build.log`.

<details><summary>Building by hand</summary>

```
npm install
npm start            # run it without building
npm run dist         # build the installer and portable .exe into dist\
```
</details>

## Turn on "Sign in with Microsoft" (needed for MSN, Outlook, Hotmail, Live)

A step-by-step version with troubleshooting is in `readme-microsoft-setup.txt`.

**This copy already has its client ID built in** (`oauth.config.json`: `63d0e01f-bf95-4299-9cd7-2e20051cc093`), so the build script won't ask for it. To use a different one, edit that file before building, or change it later in Settings → Microsoft sign-in.

You need one free Entra app registration, made once. It takes about five minutes.

1. Go to entra.microsoft.com, sign in with any Microsoft account, and open **App registrations**. Choose **New registration**.
2. Fill in the registration:
   - Name: `Quiet Inbox`
   - Supported account types: **Personal Microsoft accounts only**. Choose "Any Entra ID tenant + personal Microsoft accounts" instead if you also want Microsoft 365 work mailboxes.
   - Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`
3. Register, then copy the **Application (client) ID** from the Overview page.
4. Open **Authentication**, set **Allow public client flows** to **Yes**, and save.

Then give Quiet Inbox the ID in **any** of these ways:

- **When building:** `Build Quiet Inbox.bat` asks for it and builds it in, so grandma never sees it.
- **Any time later, no rebuild:** use **Settings → Microsoft sign-in**, or paste it into the add-account screen the first time someone types an MSN or Outlook address.

No API permissions or client secret are needed. Quiet Inbox asks for the IMAP permission (`IMAP.AccessAsUser.All`) plus `offline_access` when she signs in.

### What signing in looks like for her

1. She types her MSN address and clicks Next.
2. A Microsoft sign-in window opens **inside Quiet Inbox**, with her address already filled in.
3. She types her password. The first time only, she chooses **Accept** on Microsoft's permission page.
4. The window **closes by itself** and her mail appears.

There's no browser and no "come back to the app" step. If the window ever won't cooperate, the screen offers "use your web browser instead".

The first time, Microsoft's permission page names the app and may mark it "unverified". That's normal for a personal app registration and safe to accept.

Microsoft keeps her signed in while Quiet Inbox is used at least every 90 days or so. If it lapses, a **Sign in again** button appears in Mail and in Settings. The sign-in window remembers her, so that usually takes a click or two.

## Put it on GitHub

Double-click `Upload to GitHub.bat`.

- **First run:** it installs Git and the GitHub CLI if needed, signs you in through your browser, and creates a **private** `quiet-inbox` repository on your account.
- **After that:** run it again to upload new changes.

The Microsoft client ID in `oauth.config.json` isn't a secret, so it's fine to keep in the repository.

## Signing in

She types her email address. Quiet Inbox finds the server by itself in three ways:

1. It knows the common providers.
2. It checks the domain's MX records, which catches Google Workspace and Microsoft 365 custom domains.
3. It falls back to Thunderbird's provider database.

| Provider | How she signs in |
|---|---|
| MSN, Outlook, Hotmail, Live | A Microsoft sign-in window opens inside the app and closes itself when she's done. Quiet Inbox never sees her password. |
| Gmail | An app password from myaccount.google.com/apppasswords (needs 2-Step Verification) |
| Yahoo, AOL, AT&T, SBCGlobal | An app password from Account security, then "Generate app password" |
| iCloud | An app-specific password from account.apple.com |
| Fastmail, Zoho | An app password |
| Most ISPs and other hosts | The normal email password |

Spaces inside Gmail, Yahoo and AOL app passwords are removed automatically. Microsoft accounts connect to `outlook.office365.com` over IMAP using the sign-in token, so every feature works the same as with other providers.

## Blocked senders

Gmail and Yahoo don't offer rules over IMAP, so Quiet Inbox does the blocking itself, which is why it lives in the tray. It checks:

- when it starts
- every 15 minutes while it's running (adjustable in Settings)

If she chooses Quit from the tray menu, blocked mail waits until the next time it starts.

Accounts and settings from an earlier "Spam Sweep" build carry over automatically.

## Files

| Path | What it does |
|---|---|
| `src/main/main.js` | Window, IPC, blocked-sender schedule, Undo |
| `src/main/providers/imap.js` | All mail work (list, read, trash, delete forever, sender search across folders, scan, restore). Gmail's quirk is handled here: "forever" moves mail to Trash and then expunges it, because expunging elsewhere only removes a label. |
| `src/main/oauth.js`, `signin-window.js` | Sign in with Microsoft: an in-app sign-in window that catches the redirect itself (with the browser loopback flow as a fallback), PKCE, and token refresh |
| `src/main/discovery.js`, `presets.js` | Server detection and the sign-in help text |
| `src/main/analytics.js`, `cache.js` | Clean up numbers and the saved scans |
| `src/renderer/` | The interface (plain JavaScript, no build step; fonts are bundled so it works offline) |

App data lives in `%APPDATA%\quiet-inbox`. Settings has a button that opens it.

## Tests

`npm test` runs the Microsoft sign-in flow against a mock login server, then the IMAP provider against a real IMAP server. Point it at a throwaway mailbox seeded with `node test/seed.js`, not a real account.

`test/ui-selftest.js` drives the full interface and saves screenshots when `QUIET_INBOX_SELFTEST` is set to a folder.
