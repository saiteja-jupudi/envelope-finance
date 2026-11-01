# SmartSpend

SmartSpend is an envelope-budgeting web app that brings financial discipline to young earners and households. Each month you record the salary, set a limit per envelope (Groceries, Rent, Eating out…) and log every spend. The app shows what's left in each envelope, flags overspends, and charts month-on-month trends. It installs to the home screen on Android and iPhone and keeps working offline.

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
