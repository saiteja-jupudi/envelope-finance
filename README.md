# SpendWise India

SpendWise India is an envelope-budgeting web app that brings financial discipline to young earners and households. Each month you record the salary, set a limit per envelope (Groceries, Rent, Eating out…) and log every spend. The app shows what's left in each envelope, flags overspends, and charts month-on-month trends. It installs to the home screen on Android and iPhone and keeps working offline.

- **Hosting:** GitHub Pages (static files in this repo)
- **Accounts and data:** Firebase Authentication (email + password, password-reset emails) and Cloud Firestore
- **Sharing:** one person creates a household and gets a 6-character code; the other signs up and joins with it

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Firebase web settings for your project |
| `firestore.rules` | Security rules: paste into Firebase → Firestore → Rules |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home-screen install and offline support |

## Setup

1. Create a Firebase project. Enable **Authentication → Email/Password** and create a **Firestore** database (production mode).
2. Register a web app and put its `firebaseConfig` in `config.js`.
3. In **Firestore → Rules**, replace the contents with `firestore.rules` and click **Publish**.
4. Enable GitHub Pages: **Settings → Pages → Deploy from a branch → main / (root)**.

## Data model

```
users/{uid}                         { householdId, name, email }
invites/{code}                      { householdId }
households/{hid}                    { inviteCode, members[], memberNames{} }
households/{hid}/months/{YYYY-MM}   { salary, envelopes: [{id, name, limit}] }
households/{hid}/txns/{id}          { month, date, envelopeId, envelopeName, amount, note, by, at }
```

## Envelope suggestions from bank statements

Account → "Suggest limits from my bank statement" (also on the empty-month screen and in the envelope editor).
Add one or more statements (PDF, Excel or CSV; password-protected PDFs are supported). They are read on the phone with
pdf.js and SheetJS (in `vendor/`, Apache-2.0); nothing from the statement is uploaded. `statement.js` rebuilds the
transaction table, works out debits and credits from the running balance, spots the salary, sorts spends into
categories, and suggests a monthly limit for each. Self-transfers and big one-off payments are kept out of the limits.
Payee categories the user picks are remembered in localStorage on that phone only.

Fixed monthly payments (same amount around the same date, 5+ months) become their own envelopes: rent, maintenance,
loan EMIs, chits, gold schemes, SIPs. A chit paid to a different account in some months (or to a new account every month)
is still matched by amount and date. The user can correct each one's kind; the choice is remembered on that phone.
