// Withings -> Cloudflare Worker -> Intervals (modular, with automatic retries)
// This Worker receives Withings notifications, validates payload, manages OAuth tokens,
// retrieves measurements, extracts configured fields, sends to Intervals, and handles errors/retries.
// ENHANCED: Now calculates daily averages when multiple measurements exist for the same day

// 🔧 Logging configuration - adjust these to control verbosity
const LOG_CONFIG = {
  // Main log levels: ERROR, WARN, INFO, DEBUG
  level: "INFO",       // For DEBUG logs (Change to level: "DEBUG", 
  
  // Enable/disable specific log categories
  categories: {
    data: true,        // DATA logs (measurements, fields, duplicates)
    api: true,         // API logs (Withings, Intervals, tokens)
    process: false,    // PROCESS logs (group processing)
    general: true      // General logs (validation, errors)
  },
  
  // Enable/disable specific operations
  operations: {
    measurements: true,    // Measurement group processing
    fields: false,         // Field extraction details
    duplicates: true,      // Duplicate checking (essential for debugging)
    intervals: true,       // Intervals API calls
    tokens: false,         // Token operations
    retries: true,         // Retry operations
    averaging: true        // Daily averaging operations
  }
};

// 🔧 Telegram notification configuration
const TELEGRAM_CONFIG = {
  enabled: true,           // Enable/disable Telegram notifications
  botToken: null,         // Will be set from environment variable
  chatId: null,           // Will be set from environment variable
  includeData: true,      // Include sent data in notifications
  includeErrors: true     // Include error notifications
};

// 🔧 Utility function for detailed logging
function log(level, message, data = null) {
  if (!shouldLog(level, "general")) return;
  
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  
  if (data !== null) {
    console[level.toLowerCase()](logMessage, data);
  } else {
    console[level.toLowerCase()](logMessage);
  }
}

// 🔧 Specialized logging functions for different operations
function logData(operation, message, data = null, level = "INFO") {
  if (!shouldLog(level, "data") || !LOG_CONFIG.operations[operation.toLowerCase()]) return;
  
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] [DATA:${operation}] ${message}`;
  
  if (data !== null) {
    console[level.toLowerCase()](logMessage, data);
  } else {
    console[level.toLowerCase()](logMessage);
  }
}

function logApi(operation, message, data = null, level = "INFO") {
  if (!shouldLog(level, "api") || !LOG_CONFIG.operations[operation.toLowerCase()]) return;
  
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] [API:${operation}] ${message}`;
  
  if (data !== null) {
    console[level.toLowerCase()](logMessage, data);
  } else {
    console[level.toLowerCase()](logMessage);
  }
}

function logProcessing(operation, message, data = null, level = "INFO") {
  if (!shouldLog(level, "process")) return;
  
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] [PROCESS:${operation}] ${message}`;
  
  if (data !== null) {
    console[level.toLowerCase()](logMessage, data);
  } else {
    console[level.toLowerCase()](logMessage);
  }
}

// 🔧 Helper function to determine if we should log
function shouldLog(level, category) {
  const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
  const currentLevel = levels[LOG_CONFIG.level] || 2;
  const messageLevel = levels[level] || 2;
  
  return LOG_CONFIG.categories[category] && messageLevel <= currentLevel;
}

// 🔧 Telegram notification functions
async function sendTelegramNotification(message, env) {
  if (!TELEGRAM_CONFIG.enabled || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });

    if (!response.ok) {
      console.error('Failed to send Telegram notification:', await response.text());
    }
  } catch (error) {
    console.error('Error sending Telegram notification:', error);
  }
}

function formatTelegramMessage(userid, results, error = null) {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  
  if (error) {
    return `🚨 <b>Withings Worker Error</b>\n` +
           `👤 User: ${userid}\n` +
           `⏰ Time: ${timestamp}\n` +
           `❌ Error: ${error}`;
  }

  if (!results || results.length === 0) {
    return `📊 <b>Withings Worker</b>\n` +
           `👤 User: ${userid}\n` +
           `⏰ Time: ${timestamp}\n` +
           `ℹ️ No data to send`;
  }

  let message = `✅ <b>Withings Data Sent</b>\n` +
                `👤 User: ${userid}\n` +
                `⏰ Time: ${timestamp}\n` +
                `📊 Days: ${results.length}\n\n`;

  results.forEach((result, index) => {
    const date = result.date;
    const fields = Object.keys(result.fields).join(', ');
    const values = Object.entries(result.fields)
      .map(([key, value]) => `${key}: ${value}${result.averagedFields && result.averagedFields.includes(key) ? ' (avg)' : ''}`)
      .join(', ');
    
    message += `${index + 1}. <b>${date}</b>\n`;
    message += `   Fields: ${fields}\n`;
    if (TELEGRAM_CONFIG.includeData) {
      message += `   Values: ${values}\n`;
    }
    if (result.measurementCount > 1) {
      message += `   📊 ${result.measurementCount} measurements averaged\n`;
    }
    if (result.dropped && result.dropped.length) {
      message += `   ⚠️ Dropped (no Intervals field): ${result.dropped.join(', ')}\n`;
    }
    message += `   Status: ${result.status}\n\n`;
  });

  return message;
}

export default {
    async fetch(request, env, ctx) {
      log("INFO", `Incoming ${request.method} request`);
      
      // 🔹 HTTP request type check
      // HEAD → used for health check
      if (request.method === "HEAD") {
        log("INFO", "Health check request - returning 200");
        return new Response("OK", { status: 200 });
      }
  
      // Only POST is allowed, otherwise return 400 error
      if (request.method !== "POST") {
        log("WARN", `Unsupported method: ${request.method}`);
        return new Response("Withings Worker: use POST", { status: 400 });
      }
  
      // 🔹 Extract payload from formData sent by Withings
      const form = await request.formData();
      const payload = Object.fromEntries(form);
      log("INFO", `ℹ️️ Payload extracted from formData: ${JSON.stringify(payload)}`);

      // 🔹 Handle subscribe (used by Withings for callback registration)
      if (payload.action === "subscribe") {
        log("INFO", "Subscribe action - returning status 0");
        return new Response(JSON.stringify({ status: 0 }), { headers: { "Content-Type": "application/json" }});
      }
  
      try {
        // 🔹 Payload validation: userid numeric, startdate numeric, enddate numeric and consistent
        log("DEBUG", "Validating payload", { userid: payload.userid, startdate: payload.startdate, enddate: payload.enddate });
        validatePayload(payload);
        log("DEBUG", "Payload validation successful");
  
        // 🔹 Immediate response to Withings to avoid timeout
        // ctx.waitUntil allows continuing async processing without blocking the response
        log("DEBUG", "Starting async processing with ctx.waitUntil");
        ctx.waitUntil(handleNotify(payload, env));
        return new Response("OK", { status: 200 });
  
      } catch (err) {
        // 🔹 If payload is invalid, log and return 400 error
        log("ERROR", "Payload validation error", err.message);
        return new Response("Invalid payload: " + err.message, { status: 400 });
      }
    }
  };
  
  // 🔧 Payload validation function
  function validatePayload(payload) {
    // Check that userid is present and numeric
    const userid = payload.userid;
    if (!userid || typeof userid !== 'string' || !/^\d+$/.test(userid)) {
      throw new Error('Invalid userid');
    }
  
    // Check that startdate is numeric (default 0 if missing)
    const startdate = payload.startdate || "0";
    if (!/^\d+$/.test(startdate)) {
      throw new Error('Invalid startdate');
    }
  
    // Check enddate is numeric and greater than or equal to startdate
    const enddate = payload.enddate || Math.floor(Date.now()/1000).toString();
    if (!/^\d+$/.test(enddate) || Number(enddate) < Number(startdate)) {
      throw new Error('Invalid enddate');
    }
  
    // Update payload with validated values
    payload.userid = userid;
    payload.startdate = startdate;
    payload.enddate = enddate;
  }
  
  // 🔧 Withings -> Intervals mapping configuration
  // Contains all Withings measurement types and how to convert them to Intervals fields
  const FIELD_MAPPING = {
    weight: { withingsType: 1, intervalsField: 'weight', decimals: 3 },
    bodyFat: { withingsType: 6, intervalsField: 'bodyFat', decimals: 2 },
    muscleMass: { withingsType: 76, intervalsField: 'WithingsMuscleMass', decimals: 2 },
    waterMass: { withingsType: 77, intervalsField: 'WithingsWaterMass', decimals: 2 },
    boneMass: { withingsType: 88, intervalsField: 'WithingsBoneMass', decimals: 3 },
    leanMass: { withingsType: 5, intervalsField: 'WithingsLeanMass', decimals: 2 },
    visceralFat: { withingsType: 170, intervalsField: 'WithingsVisceralFat', decimals: 1 },
    bmr: { withingsType: 226, intervalsField: 'WithingsBMR', decimals: 0 },
    metabolicAge: { withingsType: 227, intervalsField: 'WithingsMetabolicAge', decimals: 0 },
  };
  
  // 🔧 Get valid token from KV or refresh if expired
  // Automatic retry included in case of error 601
  async function getValidAccessToken(userid, env) {
    const tokenKey = `token_data_${userid}`;
    log("DEBUG", `Getting valid access token for userid: ${userid}`);
    
    try {
      const tokenDataStr = await env.MY_KV.get(tokenKey);
      if (tokenDataStr) {
        const tokenData = JSON.parse(tokenDataStr);
        const now = Math.floor(Date.now() / 1000);
        // If token is valid with 60s buffer, return immediately
        if (tokenData.expires_at && now < tokenData.expires_at - 60) {
          log("DEBUG", `Valid token found in KV for userid: ${userid}, expires in ${tokenData.expires_at - now} seconds`);
          return tokenData.access_token;
        }
        log("DEBUG", `Token expired for userid: ${userid}, refreshing...`);
      } else {
        log("DEBUG", `No token found in KV for userid: ${userid}, refreshing...`);
      }
      // Token missing or expired → refresh
      return await refreshAccessToken(userid, env);
    } catch (err) {
      log("ERROR", "getValidAccessToken error", err.message);
      throw err;
    }
  }
  
  // 🔧 Refresh token with automatic retry up to 3 attempts on error 601
  async function refreshAccessToken(userid, env, retryCount = 0) {
    const refreshKey = `refresh_${userid}`;
    const tokenKey = `token_data_${userid}`;
    
    log("DEBUG", `Refreshing access token for userid: ${userid} (attempt ${retryCount + 1})`);
  
    const refreshToken = await env.MY_KV.get(refreshKey);
    if (!refreshToken) {
      log("ERROR", `No refresh token found for userid: ${userid}`);
      throw new Error(`No refresh token for userid ${userid}`);
    }
  
    const tokenResp = await fetch("https://wbsapi.withings.net/v2/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "requesttoken",
        grant_type: "refresh_token",
        client_id: env.WITHINGS_CLIENT_ID,
        client_secret: env.WITHINGS_CLIENT_SECRET,
        refresh_token: refreshToken
      })
    });
  
    const tokenJson = await tokenResp.json();
    logApi("TOKENS", `Token refresh response status: ${tokenJson.status}`, tokenJson, "DEBUG");
  
    // Smart retry on error 601
    if (tokenJson.status === 601 && retryCount < 3) {
      const waitSeconds = tokenJson.body?.wait_seconds || 10;
      log("WARN", `Rate limited (601), waiting ${waitSeconds} seconds before retry ${retryCount + 1}`);
      await new Promise(res => setTimeout(res, waitSeconds * 1000));
      return refreshAccessToken(userid, env, retryCount + 1);
    }
  
    if (tokenJson.status !== 0 || !tokenJson.body?.access_token) {
      log("ERROR", "Token refresh failed", tokenJson);
      throw new Error(`Refresh token failed: ${JSON.stringify(tokenJson)}`);
    }
  
    const tokenData = {
      access_token: tokenJson.body.access_token,
      refresh_token: tokenJson.body.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + tokenJson.body.expires_in,
      token_type: tokenJson.body.token_type,
      updated_at: new Date().toISOString()
    };
  
    await env.MY_KV.put(tokenKey, JSON.stringify(tokenData));
    await env.MY_KV.put(refreshKey, tokenJson.body.refresh_token);
    
    logApi("TOKENS", `Token refresh successful for userid: ${userid}, expires in ${tokenJson.body.expires_in} seconds`, null, "DEBUG");
  
    return tokenJson.body.access_token;
  }
  
  // 🔧 NEW: Function to group measurements by date and calculate daily averages
  function groupMeasurementsByDate(groups) {
    const dailyMeasurements = {};
    
    for (const grp of groups) {
      const date_iso = new Date(grp.date * 1000).toISOString();
      const date = date_iso.slice(0, 10); // Extract YYYY-MM-DD
      
      if (!dailyMeasurements[date]) {
        dailyMeasurements[date] = [];
      }
      
      // Process measures for this group
      const processed = grp.measures.map(m => ({
        type: Number(m.type),
        raw_value: m.value,
        unit: Number(m.unit),
        value: Number(m.value) * Math.pow(10, Number(m.unit))
      }));
      
      dailyMeasurements[date].push({
        grpid: grp.grpid || `${grp.date}`,
        timestamp: grp.date,
        date_iso,
        measures: processed
      });
    }
    
    return dailyMeasurements;
  }
  
  // 🔧 NEW: Function to calculate daily averages for each field
  function calculateDailyAverages(dailyMeasurements) {
    const dailyAverages = {};
    
    for (const [date, measurements] of Object.entries(dailyMeasurements)) {
      logData("AVERAGING", `📊 Calculating averages for ${date} with ${measurements.length} measurements`, null, "DEBUG");
      
      // Collect all field values for this date
      const fieldValues = {};
      const averagedFields = [];
      
      // Extract all field values from all measurements of the day
      for (const measurement of measurements) {
        const extractedFields = extractConfiguredFields(measurement.measures);
        
        for (const [fieldName, value] of Object.entries(extractedFields)) {
          if (!fieldValues[fieldName]) {
            fieldValues[fieldName] = [];
          }
          fieldValues[fieldName].push(value);
        }
      }
      
      // Calculate averages for each field
      const averages = {};
      for (const [fieldName, values] of Object.entries(fieldValues)) {
        if (values.length > 0) {
          const config = FIELD_MAPPING[fieldName];
          const average = values.reduce((sum, val) => sum + val, 0) / values.length;
          averages[fieldName] = Number(average.toFixed(config.decimals));
          
          if (values.length > 1) {
            averagedFields.push(fieldName);
            logData("AVERAGING", `📊 Field ${fieldName}: averaged ${values.length} values [${values.join(', ')}] = ${averages[fieldName]}`, null, "DEBUG");
          } else {
            logData("AVERAGING", `📊 Field ${fieldName}: single value ${averages[fieldName]}`, null, "DEBUG");
          }
        }
      }
      
      if (Object.keys(averages).length > 0) {
        // Use the most recent measurement's metadata for the daily average
        const latestMeasurement = measurements.reduce((latest, current) => 
          current.timestamp > latest.timestamp ? current : latest
        );
        
        dailyAverages[date] = {
          date,
          date_iso: date + 'T12:00:00.000Z', // Use noon for daily averages
          fields: averages,
          averagedFields,
          measurementCount: measurements.length,
          grpids: measurements.map(m => m.grpid),
          latestGrpid: latestMeasurement.grpid
        };
        
        logData("AVERAGING", `✅ Daily averages calculated for ${date}`, {
          fields: averages,
          measurementCount: measurements.length,
          averagedFields
        }, "DEBUG");
      }
    }
    
    return dailyAverages;
  }
  
  // 🔧 Notify processing with automatic retry also for Intervals - ENHANCED with daily averaging
  async function handleNotify(payload, env) {
    const { userid, startdate, enddate } = payload;
    log("DEBUG", `Starting handleNotify for userid: ${userid}, startdate: ${startdate}, enddate: ${enddate}`);
    
    const results = []; // Track successful sends for Telegram notification
  
    try {
      // 🔹 Get valid access token
      const accessToken = await getValidAccessToken(userid, env);
  
      // 🔹 Retrieve Withings measurements
      logApi("WITHINGS", `Calling Withings API for userid: ${userid}`, null, "DEBUG");
      const params = new URLSearchParams({ action: "getmeas", startdate, enddate });
      const measResp = await fetch("https://wbsapi.withings.net/measure", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });
  
      const measJson = await measResp.json();
      logApi("WITHINGS", `API response status: ${measJson?.status}`, measJson, "DEBUG");
      
      if (!measJson || measJson.status !== 0 || !measJson.body) {
        logApi("WITHINGS", "No valid data from Withings API", measJson, "WARN");
        await sendTelegramNotification(formatTelegramMessage(userid, [], "No valid data from Withings API"), env);
        return;
      }
  
      const groups = measJson.body.measuregrps || [];
      logData("MEASUREMENTS", `📊 Processing ${groups.length} measurement groups for userid: ${userid}`);
      
      if (!groups.length) {
        logData("MEASUREMENTS", "No measurement groups found", null, "WARN");
        await sendTelegramNotification(formatTelegramMessage(userid, [], "No measurement groups found"), env);
        return;
      }
  
      // 🔹 NEW: Group measurements by date and calculate daily averages
      const dailyMeasurements = groupMeasurementsByDate(groups);
      const dailyAverages = calculateDailyAverages(dailyMeasurements);
      
      logData("AVERAGING", `📊 Grouped into ${Object.keys(dailyMeasurements).length} days, calculated ${Object.keys(dailyAverages).length} daily averages`, null, "DEBUG");
  
      // 🔹 Process each day's averages
      for (const [date, dayData] of Object.entries(dailyAverages)) {
        const { fields: extractedData, averagedFields, measurementCount, grpids, latestGrpid } = dayData;
        
        logData("FIELDS", `Processed daily averages for ${date}`, extractedData, "DEBUG");
        
        if (!Object.keys(extractedData).length) {
          logData("FIELDS", `No configured fields found for ${date}, skipping`, null, "WARN");
          continue;
        }
  
        // 🔹 Determine which fields are new (use latest grpid for duplicate checking)
        const alreadySent = await getAlreadySentFields(userid, latestGrpid, env);
        const newFields = getNewFieldsToSend(extractedData, alreadySent);
        
        // Log summary of duplicates and new fields
        const duplicateCount = Object.keys(extractedData).length - Object.keys(newFields).length;
        if (duplicateCount > 0) {
          logData("DUPLICATES", `${duplicateCount} fields already sent for ${date}`, Object.keys(extractedData).filter(field => alreadySent[field] === extractedData[field]), "DEBUG");
        }
        
        if (!Object.keys(newFields).length) {
          logData("DUPLICATES", `All ${Object.keys(extractedData).length} fields already sent for ${date}, skipping`, null, "DEBUG");
          continue;
        }
        
        logData("DUPLICATES", `${Object.keys(newFields).length} new fields to send for ${date}`, Object.keys(newFields), "DEBUG");
  
        // 🔹 Automatic retry Intervals send up to 2 attempts
        let attempts = 0;
        let sent = false;
        
        logApi("INTERVALS", `Sending ${Object.keys(newFields).length} fields to Intervals for ${date} (${measurementCount} measurements averaged)`);
        
        while (attempts < 2 && !sent) {
          attempts++;
          
          const sendRes = await sendToIntervals({ date_iso: dayData.date_iso, wellnessData: newFields }, env);
          
          if (sendRes.ok) {
            // Only the fields Intervals actually accepted. Drop-unknown-and-retry (see
            // sendToIntervals) may have removed fields that have no matching custom
            // wellness field yet, so we never mark those as "sent".
            const acceptedFields = sendRes.accepted;
            logApi("INTERVALS", `✅ Successfully sent to Intervals: ${Object.keys(acceptedFields).join(', ') || '(none)'} for ${date}`, acceptedFields);
            if (sendRes.dropped && sendRes.dropped.length) {
              log("WARN", `⚠️ Dropped fields with no matching Intervals custom wellness field for ${date}: ${sendRes.dropped.join(', ')}. Create them in Intervals to capture these metrics.`);
            }
            // Save only accepted fields so dropped ones are retried once their field exists.
            await saveSuccessfulFields(userid, latestGrpid, acceptedFields, sendRes.status, env);

            // Track successful send for Telegram notification
            results.push({
              date,
              fields: acceptedFields,
              averagedFields,
              measurementCount,
              status: sendRes.status,
              dropped: sendRes.dropped
            });

            sent = true;
          } else {
            log("WARN", `❌ Intervals send failed (attempt ${attempts}) for ${date}`, { status: sendRes.status, text: sendRes.text });
            if (attempts < 2) {
              logApi("INTERVALS", `Retrying in 2 seconds for ${date}`, null, "DEBUG");
              await new Promise(r => setTimeout(r, 2000)); // brief delay between retries
            }
          }
        }
  
        // 🔹 If still failed → save to KV for future manual retry
        if (!sent) {
          logData("RETRIES", `All retries failed for ${date}, saving for manual retry`, null, "ERROR");
          await env.MY_KV.put(`retry_${userid}_${latestGrpid}`, JSON.stringify({
            attemptAt: new Date().toISOString(),
            fields: newFields,
            date,
            measurementCount,
            averagedFields
          }));
        }
      }
      
      logData("MEASUREMENTS", `✅ Completed processing ${Object.keys(dailyAverages).length} days for userid: ${userid}`);
      
      // Send Telegram notification with results
      await sendTelegramNotification(formatTelegramMessage(userid, results), env);
  
    } catch (err) {
      log("ERROR", "handleNotify error", err.message);
      
      // Send Telegram notification for errors
      if (TELEGRAM_CONFIG.includeErrors) {
        await sendTelegramNotification(formatTelegramMessage(userid, [], err.message), env);
      }
    }
  }
  
  // 🔧 Utility functions
  function extractConfiguredFields(measures) {
    const extracted = {};
    for (const [fieldName, config] of Object.entries(FIELD_MAPPING)) {
      const measure = measures.find(m => m.type === config.withingsType);
      if (measure?.value != null) extracted[fieldName] = Number(measure.value.toFixed(config.decimals));
    }
    return extracted;
  }
  
  async function getAlreadySentFields(userid, grpid, env) {
    const sentKey = `sent_${userid}_${grpid}`;
    const existing = await env.MY_KV.get(sentKey);
    if (!existing) return {};
    try { return JSON.parse(existing).fields || {}; } catch { return {}; }
  }
  
  function getNewFieldsToSend(extractedData, alreadySent) {
    const newFields = {};
    for (const [fieldName, value] of Object.entries(extractedData)) {
      if (!(fieldName in alreadySent) || alreadySent[fieldName] !== value) {
        newFields[fieldName] = value;
      }
    }
    return newFields;
  }
  
  // 🔧 Save successfully sent fields
  async function saveSuccessfulFields(userid, grpid, newFields, status, env) {
    const sentKey = `sent_${userid}_${grpid}`;
    const existing = await getAlreadySentFields(userid, grpid, env);
    const allFields = { ...existing, ...newFields };
    await env.MY_KV.put(sentKey, JSON.stringify({
      lastSentAt: new Date().toISOString(),
      status,
      fields: allFields
    }));
  }
  
  // 🔧 Parse the offending field code out of an Intervals 422 body, e.g.
  // {"error":"Unrecognized wellness field [WithingsMuscleMass] for athlete i579914"}
  function parseUnrecognizedField(text) {
    const m = /Unrecognized wellness field \[([^\]]+)\]/i.exec(text || "");
    return m ? m[1] : null;
  }

  // 🔧 Send data to Intervals
  // Hardened: Intervals rejects the WHOLE record with 422 if any single field code is
  // not defined for the athlete. We strip the named field and retry so every recognised
  // field still saves. Returns which fields were accepted vs dropped.
  async function sendToIntervals({ date_iso, wellnessData }, env) {
    const date = date_iso.slice(0, 10); // YYYY-MM-DD
    const athleteId = env.INTERVALS_ATHLETE_ID;
    const apiKey = env.INTERVALS_API_KEY;
    const url = `https://intervals.icu/api/v1/athlete/${athleteId}/wellness/${date}`;
    const auth = "Basic " + btoa(`API_KEY:${apiKey}`);

    // Build the payload keyed by Intervals field code, keeping a reverse map so a field
    // named in a 422 can be dropped (and reported) by that code.
    const payload = {};
    const codeToFieldName = {};
    for (const [fieldName, value] of Object.entries(wellnessData)) {
      const config = FIELD_MAPPING[fieldName];
      if (config) {
        payload[config.intervalsField] = value;
        codeToFieldName[config.intervalsField] = fieldName;
      }
    }

    const dropped = []; // field names removed because Intervals doesn't recognise them
    let resp = null;
    let text = "";
    let guard = Object.keys(payload).length + 1; // each failed pass removes >= 1 field

    while (guard-- > 0) {
      if (Object.keys(payload).length === 0) {
        return { ok: false, status: 422, text: "All fields unrecognised by Intervals", accepted: {}, dropped };
      }

      resp = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        body: JSON.stringify(payload)
      });
      text = await resp.text();

      if (resp.ok) break;

      // Drop the unrecognised field named in a 422 and retry; otherwise stop.
      const unknownCode = resp.status === 422 ? parseUnrecognizedField(text) : null;
      if (unknownCode && unknownCode in payload) {
        delete payload[unknownCode];
        dropped.push(codeToFieldName[unknownCode] || unknownCode);
        logApi("INTERVALS", `⚠️ Intervals rejected unrecognised field '${unknownCode}' for ${date}; dropping and retrying`, null, "WARN");
        continue;
      }
      break;
    }

    // Map the surviving payload back to wellnessData field names for the caller.
    const accepted = {};
    if (resp && resp.ok) {
      for (const code of Object.keys(payload)) {
        const fieldName = codeToFieldName[code];
        if (fieldName) accepted[fieldName] = wellnessData[fieldName];
      }
    }

    return { ok: !!(resp && resp.ok), status: resp ? resp.status : 0, text, accepted, dropped };
  }