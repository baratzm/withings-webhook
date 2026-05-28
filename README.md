Withings → Cloudflare Worker → Intervals
========================================

This project implements a **Cloudflare Worker** that receives notifications from Withings, extracts relevant measurements, and automatically sends them to the **Intervals.icu** service.The Worker is designed to be modular, scalable, and robust, with OAuth token management, payload validation, automatic retries, daily averaging, and support for manual retry.

📌 Main Features
----------------

*   Receives **POST** notifications from Withings (notify) and handles subscription (subscribe)
*   Complete payload validation: userid, startdate, enddate
*   Obtains valid **access token** from KV or automatic refresh
*   Calls Withings API measure?action=getmeas to retrieve measurements
*   **Daily averaging**: Automatically groups multiple measurements per day and calculates averages
*   Extracts configured fields (weight, muscle mass, body fat, etc.)
*   Sends data to **Intervals.icu** with automatic retry (2 attempts)
*   Duplicate detection to avoid sending the same data twice
*   Saves to KV for manual retry in case of failure
*   **Comprehensive logging system** with configurable verbosity and operation tracking
*   **Telegram notifications** for successful sends and errors (optional)

⚡ Installation
--------------

1.  **Create the Worker** on Cloudflare Workers
2.  **Create KV Namespace** (see Configuration section below)
3.  **Configure environment variables** (see Configuration section below)
4.  **Deploy the Worker** via Wrangler or Cloudflare UI
5.  **Setup OAuth tokens** for each user (see Initial Setup section below)
6.  **Create the custom wellness fields** in Intervals.icu (see [Creating the Custom Wellness Fields](#-creating-the-custom-wellness-fields-in-intervalsicu) below) — required before body-composition metrics will be accepted

🔧 Configuration
----------------

### 1\. Cloudflare KV Namespace (Required First)

The Worker needs a KV namespace to store tokens and data:

**How to configure it:**

*   In the Cloudflare dashboard, go to Workers → KV
*   Click "Create Namespace"
*   Assign a name (e.g. withings-kv) and click "Create"
*   Go back to your Worker, go to Settings → Variables
*   Add an environment variable:
    *   Variable name: MY\_KV
    *   Value: select the newly created namespace from the dropdown   
*   Click "Save"

### 2\. Withings OAuth Credentials

*   WITHINGS\_CLIENT\_ID - Withings OAuth client ID
*   WITHINGS\_CLIENT\_SECRET - Withings OAuth client secret

**How to obtain them:**

*   Go to [Withings Developer](https://developer.withings.com/)
*   Register/Login to your account
*   Create a new application
*   In the app dashboard, copy:
    *   Client ID → WITHINGS\_CLIENT\_ID
    *   Client Secret → WITHINGS\_CLIENT\_SECRET (keep this value secret)
        

### 3\. Intervals.icu API Credentials

*   INTERVALS\_ATHLETE\_ID - Intervals athlete ID
*   INTERVALS\_API\_KEY - Intervals API Key

**How to obtain them:**

*   Login to your Intervals.icu account
*   Go to Settings → API
*   Copy your Athlete ID → INTERVALS\_ATHLETE\_ID
*   Generate a new API Key → INTERVALS\_API\_KEY

### 4\. Telegram Bot Notifications (Optional)

*   TELEGRAM\_BOT\_TOKEN - Telegram bot token for notifications
*   TELEGRAM\_CHAT\_ID - Telegram chat ID to receive notifications

**How to obtain them:**

*   Create a new bot with [@BotFather](https://t.me/botfather) on Telegram
*   Send /newbot and follow the instructions
*   Copy the bot token → TELEGRAM\_BOT\_TOKEN
*   Start a chat with your bot and send any message
*   Visit https://api.telegram.org/bot/getUpdates
*   Find your chat ID in the response → TELEGRAM\_CHAT\_ID

🚀 Initial Setup (One-time per user)
------------------------------------

Before the Worker can function, you need to obtain the initial OAuth tokens for each user. This is a **one-time setup** per user.

### Step 1: Get Authorization Code

1.  **Visit the OAuth URL:**
```js
https://account.withings.com/oauth2\_user/authorize2?response\_type=code&client\_id=YOUR\_CLIENT\_ID&redirect\_uri=YOUR\_REDIRECT\_URI&scope=user.metrics&state=random\_string
```
  *   Replace YOUR\_CLIENT\_ID with your actual client ID
  *   Replace YOUR\_REDIRECT\_URI with your configured redirect URI
  *   The user will be redirected to your redirect URI with a code parameter

2.  **Extract the code from the redirect URL:**
   *   The code will be in the URL parameter: ?code=ABC123...
   *   **⚠️ IMPORTANT:** The authorization code expires in **10 minutes**, so you must use it quickly!
        

### Step 2: Exchange Code for Tokens

**Execute this command immediately after getting the code:**

```bash
curl -s -X POST "https://wbsapi.withings.net/v2/oauth2" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "action=requesttoken" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=YOUR_REDIRECT_URI"
```

**Response will contain:**

*   access\_token (expires in 3 hours)
*   refresh\_token (expires in 6 months)
*   expires\_in (seconds until access\_token expires)

### Step 3: Store Tokens in KV

Save the response tokens to your Cloudflare KV namespace:

**Key: token\_data\_${userid}**

```json
{
  "access_token": "your_access_token",
  "refresh_token": "your_refresh_token", 
  "expires_at": 1234567890,
  "token_type": "Bearer",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

**Key: refresh\_${userid}**

```
your_refresh_token_string
```

> **Note:** After this initial setup, the Worker handles automatic token refresh. You only need to do this once per user.

### Step 4: Register Webhook with Withings

Configure your webhook URL in the Withings Developer dashboard to point to your Worker URL.

📊 Daily Averaging Feature
--------------------------

The Worker automatically handles multiple measurements per day by calculating daily averages:

### How it works:

1.  **Groups measurements by date** (YYYY-MM-DD)
2.  **Calculates averages** for each field when multiple measurements exist
3.  **Preserves single measurements** as-is when only one exists
4.  **Uses noon timestamp** (12:00:00) for daily averages
5.  **Tracks which fields were averaged** for transparency

### Benefits:

*   **Prevents duplicate data** when multiple measurements occur on the same day
*   **Provides meaningful daily values** instead of random measurement selection
*   **Maintains data consistency** with Intervals.icu's daily wellness format
*   **Reduces API calls** by combining multiple measurements into one send

### Example:

If you weigh yourself 3 times on January 15th:

*   Morning: 75.2 kg
*   Afternoon: 75.5 kg
*   Evening: 75.1 kg

The Worker sends: weight: 75.3 (average) with timestamp 2024-01-15T12:00:00.000Z

🔧 Logging Configuration
------------------------

The Worker includes a comprehensive logging system that can be customized:

### Log Levels
```js
const LOG_CONFIG = {
  level: "INFO",       // ERROR, WARN, INFO, DEBUG
  
  categories: {
    data: true,        // Measurements, fields, duplicates
    api: true,         // Withings, Intervals, tokens  
    process: false,    // Group processing details
    general: true      // Validation, errors
  },
  
  operations: {
    measurements: true,    // Measurement processing
    fields: false,         // Field extraction details
    duplicates: true,      // Duplicate checking
    intervals: true,       // Intervals API calls
    tokens: false,         // Token operations
    retries: true,         // Retry operations
    averaging: true        // Daily averaging operations
  }
};
```

### Customizing Logs

*   Set level: "DEBUG" for maximum verbosity during development
*   Enable specific categories and operations based on your debugging needs
*   Production recommendation: level: "INFO" with essential operations enabled

📝 Project Structure
--------------------

*   worker.js → main Worker code
    *   fetch → HTTP entry point
    *   handleNotify(payload, env) → async notification processing
    *   getValidAccessToken(userid, env) → token retrieval with caching
    *   refreshAccessToken(userid, env) → token refresh with automatic retry
    *   groupMeasurementsByDate(groups) → **NEW**: groups measurements by date
    *   calculateDailyAverages(dailyMeasurements) → **NEW**: calculates daily averages
    *   Helper functions:
        *   extractConfiguredFields
        *   sendToIntervals
        *   getAlreadySentFields
        *   saveSuccessfulFields
        *   getNewFieldsToSend
        *   validatePayload
        *   Logging functions: log, logData, logApi, logProcessing
            
*   FIELD\_MAPPING → mapping between Withings and Intervals fields

🔧 Field Mapping
----------------

The Worker supports the following Withings measurements:

## 🔧 Field Mapping

The Worker supports the following Withings measurements:

| Withings Field | Withings Type | Intervals Field | Decimals |
|----------------|---------------|-----------------|----------|
| Weight | 1 | weight | 3 |
| Body Fat % | 6 | bodyFat | 2 |
| Muscle Mass | 76 | WithingsMuscleMass | 2 |
| Water Mass | 77 | WithingsWaterMass | 2 |
| Bone Mass | 88 | WithingsBoneMass | 3 |
| Lean Mass | 5 | WithingsLeanMass | 2 |
| Visceral Fat | 170 | WithingsVisceralFat | 1 |
| BMR | 226 | WithingsBMR | 0 |
| Metabolic Age | 227 | WithingsMetabolicAge | 0 |

> To add new fields, update the `FIELD_MAPPING` object in the code.

🔧 Creating the Custom Wellness Fields in Intervals.icu
------------------------------------------------------

Intervals.icu has only two **built-in** wellness fields used by this Worker — `weight` and `bodyFat` — which work with no setup. **Every other field in the mapping table above is a _custom wellness field_ that you must create in Intervals.icu _before_ the Worker can send it.** Until the field exists, the Intervals API rejects the request with:

```
422 Unrecognized wellness field [WithingsMuscleMass] for athlete iXXXXXX
```

and it rejects the **entire day's record** — so `weight` and `bodyFat` for that day are dropped too, not just the unknown field.

### Where to create them (the step people get wrong)

Custom **wellness** fields are a *different feature* from custom **activity / sport** fields:

- ✅ **Correct** — open a day's **wellness entry dialog** (home / calendar → click the day's wellness entry), then click **“Fields”** → the **“+”** button to add a new field.
- ❌ **Wrong** — *Settings → Sport Settings → (Ride / Other) → Custom Fields*. Those are **activity** fields; the wellness API never reads them, so using them reproduces the same 422.

### Field configuration

Create one custom wellness field per row below. **The `Code` is the only value that must be exact** — it is case-sensitive and must match the **Intervals Field** value from the mapping table above (the `intervalsField` the Worker sends). The **`Name`** can be any friendly label you like.

| Name | Code (must match exactly) | Type | Unit | Min | Max | Prefix | Format | Suffix | Example | Notes |
|------|---------------------------|------|------|-----|-----|--------|--------|--------|---------|-------|
| Muscle Mass | `WithingsMuscleMass` | Numeric | kg | 0 | 100 | — | `.2f` | `kg` | `61.82` | Muscle weight (BIA) |
| Water Mass | `WithingsWaterMass` | Numeric | kg | 0 | 100 | — | `.2f` | `kg` | `43.06` | Total body water |
| Bone Mass | `WithingsBoneMass` | Numeric | kg | 0 | 10 | — | `.3f` | `kg` | `3.220` | Dry skeletal mass |
| Lean Mass | `WithingsLeanMass` | Numeric | kg | 0 | 150 | — | `.2f` | `kg` | `65.06` | Fat-free mass |
| Visceral Fat | `WithingsVisceralFat` | Numeric | — | 0 | 30 | — | `.1f` | — | `8.0` | Abdominal fat index |
| BMR | `WithingsBMR` | Numeric | kcal | 0 | 6000 | — | `.0f` | `kcal` | `1750` | Resting calorie burn |
| Metabolic Age | `WithingsMetabolicAge` | Numeric | years | 0 | 120 | — | `.0f` | `yr` | `35` | BMR vs. age group |

Notes on the columns:

- **Format** uses [d3-format](https://d3js.org/d3-format) notation: `.2f` = 2 decimals, `.3f` = 3 decimals, `.1f` = 1 decimal, `.0f` = integer. Keep it consistent with the **Decimals** column in the mapping table above.
- `—` means leave that field blank.
- ⚠️ **The OK button stays greyed out until the `Example` value matches the `Format`.** For example, with format `.2f` the Example must have exactly two decimals (`61.82`). The validation message only appears **after you click into (touch) the Example field** — so if **OK** is disabled and nothing looks wrong, focus the Example field and correct its decimals to match the format.
- **Only create the fields your scale actually reports.** Most Body / Body+ scales send the first four (muscle, water, bone, lean mass). Visceral Fat, BMR and Metabolic Age (Withings types 170 / 226 / 227) come from higher-end models only — create them only if your scale sends them; otherwise they simply stay empty.

For what each metric means, see Withings’ [body composition & BIA guide](https://support.withings.com/hc/en-us/articles/22480153133841-Body-Smart-Learn-more-about-body-composition-and-bioelectrical-impedance-analysis-BIA).

🔧 Payload Validation
---------------------

Every notify payload is validated:

*   **userid**: required, numeric string
*   **startdate**: optional, default "0", numeric string (Unix timestamp in seconds)
*   **enddate**: optional, default current timestamp, numeric string (Unix timestamp in seconds)
*   **enddate** must be greater than or equal to **startdate**

> **Important**: Withings expects Unix timestamps in **seconds**, not milliseconds. If using JavaScript timestamps, divide by 1000.

If the payload is invalid, the Worker responds with **400** and logs the error.

🔄 Token Management
-------------------

*   Tokens stored in KV for each userid
*   **Token Expiration Times:**
    *   access\_token: **3 hours** (automatically refreshed by Worker)
    *   refresh\_token: **6 months** (used to get new access\_token)
    *   authorization\_code: **10 minutes** (only during initial setup)
        
*   If access\_token is expired or missing, **automatic refresh** is performed via refresh\_token
*   Automatic retry up to **3 attempts** on error 601 (Rate Limited)
*   Worker checks token validity with 60-second buffer before expiration

✅ Sending Data to Intervals
---------------------------

*   **Daily averaging** applied when multiple measurements exist for the same date
*   Only **new** or **modified** fields are sent (duplicate detection)
*   Automatic retry **2 times** if sending fails
*   If all retries fail, data is saved to KV for future manual retry
*   Uses latest measurement's grpid for duplicate checking when averaging

📦 KV Storage
-------------

Main keys:

| Key | Content |
|-----|---------|
| `token_data_${userid}` | Token data with `access_token`, `refresh_token`, `expires_at` |
| `refresh_${userid}` | Refresh token |
| `sent_${userid}_${grpid}` | Fields already sent for a measurement group |
| `retry_${userid}_${grpid}` | Data to send manually if retry failed |

📱 Telegram Notifications
-------------------------

The Worker can send notifications to Telegram for successful data sends and errors. This is **optional** and requires additional configuration.

### Notification Types

#### **Successful Data Send**
```
✅ Withings Data Sent
👤 User: 12345
⏰ Time: 2024-01-15 12:30:00
📊 Days: 2

1. 2024-01-15
   Fields: weight, bodyFat
   Values: weight: 75.5 (avg), bodyFat: 1.52
   📊 3 measurements averaged
   Status: 200

2. 2024-01-14
   Fields: muscleMass
   Values: muscleMass: 45.2
   Status: 200
```
#### **Error Notification**
```
🚨 Withings Worker Error
👤 User: 12345
⏰ Time: 2024-01-15 12:30:00
❌ Error: Token refresh failed
```

#### **No Data Notification**
```
📊 Withings Worker
👤 User: 12345
⏰ Time: 2024-01-15 12:30:00
ℹ️ No data to send
```

### Configuration

Set these environment variables to enable notifications:

*   TELEGRAM\_BOT\_TOKEN - Your bot token from @BotFather
*   TELEGRAM\_CHAT\_ID - Your chat ID

If these variables are not set, notifications will be disabled automatically.

### Customization

You can modify the notification behavior in the TELEGRAM\_CONFIG object:

*   enabled: true - Enable/disable notifications
*   includeData: true - Include field values in notifications
*   includeErrors: true - Send notifications for errors

⚠️ Error Handling
-----------------

*   All errors are logged to console with detailed context
*   Main flows are not blocked by errors: the Worker responds immediately to Withings
*   Automatic retries managed for tokens and Intervals sending
*   Persistent data saved for manual retry if necessary
*   Comprehensive error logging helps with troubleshooting
*   **Rate limiting** handled automatically with exponential backoff

🌐 General Flow
---------------

### Initial Setup Flow

1.  **OAuth Authorization** → User authorizes your app via Withings OAuth
2.  **Token Exchange** → Exchange authorization code for access/refresh tokens
3.  **Token Storage** → Store tokens in Cloudflare KV for each user
4.  **Webhook Registration** → Withings calls your Worker URL for notifications

### Runtime Flow (After Setup)

1.  HTTP request → HEAD or POST
2.  subscribe → immediate response {status:0}
3.  notify → payload validation
4.  Immediate response "OK" + ctx.waitUntil(handleNotify)
5.  Retrieve valid access token (KV cache or refresh)
6.  Call Withings API getmeas
7.  **NEW**: Group measurements by date and calculate daily averages
8.  Process averaged data and extract configured fields
9.  Check already sent → send new fields to Intervals
10.  Automatic retry on failed send → save to KV for manual retry
11.  Send Telegram notification (if configured)
12.  Complete logging at every step

🛠️ Tips
--------

### Development

*   Update FIELD\_MAPPING to add new Withings measurement types
*   Set LOG\_CONFIG.level: "DEBUG" for detailed debugging
*   Enable specific log categories based on what you're troubleshooting
*   Use daily averaging feature to handle multiple daily measurements gracefully

### Production

*   Set LOG\_CONFIG.level: "INFO" for optimal performance
*   Monitor Worker logs for ERROR level messages
*   Set up alerts for critical errors using log monitoring
*   Enable Telegram notifications for real-time status updates

### Monitoring

*   Track retry patterns to identify potential API issues
*   Monitor token refresh frequency to detect authentication problems
*   Use averaging logs to understand measurement patterns
*   Periodic KV cleanup recommended to avoid old data accumulation

### Troubleshooting Common Issues

- **"Invalid userid"**  
  Ensure `userid` is a numeric string.

- **"Token refresh failed"**  
  Check if the refresh token has expired (valid for 6 months).

- **"All retries failed"**  
  Check Intervals.icu API status and credentials.

- **No data sent**  
  Verify field mapping matches your Withings device capabilities.

- **Timestamp issues**  
  Remember Withings uses Unix timestamps in **seconds**, not milliseconds.

- **"Not implemented" (status 2554)**  
  This error happens if you call the wrong endpoint.  
  Always use:
  https://wbsapi.withings.net/notify
  (⚠️ do not use `/v2/notify`)

- **Old callback URL still shown in `action=list` after GUI callback URL edit**  
  The Withings Developer portal shows the **global callback URL** for your app,  
  but API subscriptions (`action=list`) display the URL that was saved at the moment of `subscribe`.  
  Updating the portal does not automatically update old subscriptions.  

  **Solution:** Revoke the old subscription and create a new one with the updated URL.  
  (Access/refresh tokens are unaffected.)

  Example workflow:
  ```bash
  # 1. List current subscription(s)
  curl -X POST "https://wbsapi.withings.net/notify" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -d "action=list&appli=1"

  # 2. Revoke old subscription (use appli + old callbackurl from step 1)
  curl -X POST "https://wbsapi.withings.net/notify" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -d "action=revoke&appli=1&callbackurl=https://old-url/withings"

  # 3. Subscribe again with the new callback URL
  curl -X POST "https://wbsapi.withings.net/notify" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -d "action=subscribe&appli=1&callbackurl=https://new-url/withings&comment=myapp"

  # 4. Verify subscription now points to the correct callback
  curl -X POST "https://wbsapi.withings.net/notify" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" \
    -d "action=list&appli=1"

📄 License
----------

All contents of this repository (code, documentation, and diagrams) are released under the [MIT](./LICENSE) license.
