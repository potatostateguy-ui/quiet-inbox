QUIET INBOX - MICROSOFT SIGN-IN SETUP
=====================================

What this is for
----------------
Outlook.com, Hotmail, Live and MSN addresses can't sign in with a password
any more. Quiet Inbox uses "Sign in with Microsoft" instead, and Microsoft
needs a free "app registration" to allow that.

You do this ONCE. It takes about 5 minutes. When you're done you'll have a
code called the Application (client) ID that you give to Quiet Inbox.

Nothing here costs money. There is no client secret, so nothing expires
and nothing needs renewing later.


Before you start
----------------
You need a Microsoft Entra tenant (directory) that you control. Use your
own: a personal or developer tenant is perfect. Don't use a client's or an
employer's tenant for a personal app.

If you have no tenant, the free Microsoft 365 Developer Program or a free
Azure account gives you one.


PART 1 - CREATE THE APP REGISTRATION
------------------------------------

1. Open https://entra.microsoft.com and sign in to your tenant.

2. Open "App registrations".
   If you don't see it in the menu, type "App registrations" in the
   search bar at the top.

3. Click "New registration".

4. Fill in the form:

   Name:
       Quiet Inbox
       (This is the name grandma sees on Microsoft's permission page.)

   Supported account types:
       Choose "Personal Microsoft accounts only".
       (This covers MSN, Outlook.com, Hotmail and Live.)

       Want Microsoft 365 work/school mailboxes too? Choose
       "Accounts in any organizational directory and personal Microsoft
       accounts" instead.

   Redirect URI:
       Platform:  Public client/native (mobile & desktop)
       Value:     http://localhost

       Type it exactly like that: http, not https, with no port number
       and no slash on the end.

5. Click "Register".


PART 2 - ONE SETTING TO TURN ON
-------------------------------

6. In the menu on the left, open "Authentication".

7. Find "Allow public client flows" (under "Advanced settings").
   Set it to YES.

8. Click "Save".

You do NOT need to add any API permissions or create a client secret.
Quiet Inbox asks for mailbox access when grandma signs in.


PART 3 - COPY THE CLIENT ID
---------------------------

9. Open "Overview" in the left menu.

10. Copy the value labelled "Application (client) ID".
    It looks like:  1a2b3c4d-1111-2222-3333-444455556666

    Be careful: copy the APPLICATION (client) ID. Don't copy the
    "Directory (tenant) ID" or the "Object ID". They look alike, and
    copying the wrong one is the most common mistake.


PART 4 - GIVE THE ID TO QUIET INBOX
-----------------------------------
Pick ONE of these:

  A) When building (recommended for grandma's copy)
     Double-click "Build Quiet Inbox.bat". When it asks for the client ID,
     paste it in. It's built into the installer, so she never sees it.

  B) In the app, any time, with no rebuild
     Open Quiet Inbox > Settings > Microsoft sign-in, paste the ID, and
     click Save.

  C) While adding the account
     Type an MSN or Outlook address in "Add your email". If no ID is set
     yet, Quiet Inbox asks for it right there.


PART 5 - TEST IT (do this on your own PC first)
-----------------------------------------------
1. In Quiet Inbox, click "Add your email account" and type an MSN or
   Outlook address.
2. A Microsoft sign-in window opens inside Quiet Inbox with the address
   filled in. Type the password and click Sign in.
3. The first time, Microsoft shows a permission page for "Quiet Inbox".
   Click Accept.
4. The window closes by itself and the mail appears.

About the permission page: it may say the app is "unverified". That's
normal for a personal app registration and safe to accept. It's worth
sitting with grandma the first time so it doesn't worry her.


TROUBLESHOOTING
---------------

"Microsoft doesn't recognize this app"
    The wrong ID was pasted, probably the Directory (tenant) ID or the
    Object ID. Go back to Part 3 and copy the Application (client) ID.

"Turn on Allow public client flows"
    Part 2 was skipped or not saved. Set it to Yes and click Save.

"The app registration doesn't allow this kind of account"
    Supported account types doesn't include personal accounts. That's
    hard to change after creation, so the easiest fix is a new app
    registration with "Personal Microsoft accounts only" (Part 1, step 4).
    Then use the new client ID.

An error mentioning the redirect URI (code AADSTS50011)
    In Authentication, make sure http://localhost is listed under
    "Mobile and desktop applications". It must NOT be under "Web" or
    "Single-page application". Add it under the right platform if needed.

"Signed in, but the mailbox didn't open"
    Personal Outlook.com/MSN mailboxes have IMAP on by default.
    For a Microsoft 365 work mailbox, an admin may have turned IMAP off
    for that user. It can be turned on in the Exchange admin center
    (Mailbox > Email apps > IMAP).

The sign-in window is blank or won't finish
    On the add-account screen, click "use your web browser instead".
    That signs in through the normal web browser.

"Microsoft wants you to sign in again"
    This happens if Quiet Inbox hasn't been used for about 90 days.
    Click "Sign in again" (in Mail, or Settings > Email accounts).


GOOD TO KNOW
------------
- The client ID is not a password. It's safe to build into the installer.
- Quiet Inbox never sees the Microsoft password. Microsoft only gives it
  permission to read and delete email in that mailbox.
- To stop Quiet Inbox's access completely, delete the app registration,
  or have the mailbox owner remove "Quiet Inbox" at
  https://account.live.com/consent/Manage
