# Apple Pay purchase alerts with an iOS Shortcut

With this set up, each Apple Pay purchase (#32) works like this:

1. **Sent at once:** an iOS Shortcuts automation sends it to Data Ledger the moment you pay.
2. **Shown as provisional:** it appears as a provisional transaction (#30).
3. **Notifies you:** it sends a notification to your phone (#29) that opens the purchase so you can categorize it.
4. **Replaced by the bank's record:** when the next daily sync brings the bank's own record, the two are matched, and anything you set carries over.

It covers Apple Pay only. Physical card swipes and online purchases without Apple Pay still arrive with the daily sync.

## What you need

- iOS 17 or later (the Shortcuts **Transaction** automation).
- Data Ledger set up for notifications on the phone, if you want the alert (Settings → **Notifications**). The purchase is recorded either way.

## 1. Create a token in Data Ledger

1. **Create the token:** Settings → **Apple Pay** → name the device (e.g. *iPhone*) → **Create token**.
2. **Copy it now:** it starts with `dlsc_`, and it's shown only once. Only a hash of it is stored.
3. **Note the endpoint URL** shown with it: `https://<your domain>/api/shortcuts/purchase`.

A lost or replaced phone: **Revoke** its token there, and create a new one for the new phone.

## 2. Map your Wallet cards

An Apple Pay alert names the card only as it appears in **Wallet**, for example *Example Rewards*. Data Ledger needs to know which account that is.

- **Ahead of time:** under **Wallet cards**, type the card's Wallet name, pick the account, then **Add card**. Matching ignores upper and lower case.
- **Or as you go:** the first purchase from an unmapped card isn't recorded. Instead you get a "New Wallet card" notification, and the name appears under Wallet cards with an account picker. That purchase still arrives with the daily sync.

## 3. Build the automation on the iPhone

1. **Start the automation:** open **Shortcuts** → **Automation** → **+** → **Transaction**.
2. **Choose the cards** to include (or all), and leave merchants as **Any**.
3. **Make it silent:** choose **Run Immediately**, so it runs without asking. Then choose **Create New Shortcut**.
4. **Add the date action:** add **Format Date**.
   - Date: **Current Date**.
   - Date Format: **ISO 8601**, with **Include Time** on.

   This gives Data Ledger the purchase's date in your own time zone.
5. **Add the request:** add **Get Contents of URL**.
   - **URL:** the endpoint from step 1.
   - **Method:** POST.
   - **Headers:** add `Authorization`, with the value `Bearer ` (with a space) followed by your token.
   - **Request Body:** JSON, with these fields, all **Text**:

     | Key | Value |
     |---|---|
     | `merchant` | Shortcut Input → **Merchant** |
     | `amount` | Shortcut Input → **Amount** |
     | `card` | Shortcut Input → the card's name (**Card** / **Card or Pass**, depending on the iOS version) |
     | `at` | the **Formatted Date** from the step before |

6. **Save.** Optionally turn off **Notify When Run**, since Data Ledger's own notification is the one you want.

## Checking it works

Pay with Apple Pay for something small. Within a few seconds:
- you should get a notification like *Lumen Bistro · $4.50*;
- the purchase should be listed under Inbox → **Waiting for the bank**.

If nothing arrives, run the shortcut by hand from the Shortcuts app. The reply shows what happened:

| Reply | Meaning |
|---|---|
| `"status": "created"` | Recorded. If you didn't get a notification, check Settings → **Notifications**. |
| `"status": "unmapped"` | The card's Wallet name isn't mapped yet (step 2). |
| `"status": "duplicate"` | The same purchase was already sent. |
| `"status": "already_synced"` | The bank reported it first, so nothing was added. |
| `401 Unauthorized` | The token is wrong or was revoked, or the header is missing `Bearer `. |
| `400` | The body is missing a field, or the amount wasn't readable. |

## What's sent, and what isn't

- **What's sent:** the merchant name, the amount, the card's Wallet name and the time. Nothing else leaves the phone, and nothing goes anywhere but your own deployment.
- **Matching:** the purchase is matched to the bank's record by account, exact amount and date (#30). A tip added later changes the amount, so a restaurant purchase may need you to pick the bank's charge under **Waiting for the bank** after a week.
