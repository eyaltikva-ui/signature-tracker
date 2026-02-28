const CONFIG = {
  FIREBASE_PROJECT_ID: 'signature-tracker-6ca1e',
  DRIVE_FOLDER_ID: '155VRDwcInG32Tl-0tTfm_rMmGgfAOhRL',
  REMINDER_EMAIL: 'eyal-t@ramat-gan.muni.il',
  SENDER_FILTER: 'nurit-sp@ramat-gan.muni.il',
  GMAIL_LABEL: 'חתימה-דיגיטלית',
  KEYWORDS: ['חתימה דיגיטלית', 'חתימה', 'אנא חתימה', 'נא לחתום'],
  MAX_THREADS: 20
};

function getFirestoreUrl(path) {
  return `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

function getAuthToken() { return ScriptApp.getOAuthToken(); }

function firestoreGet(path) {
  const response = UrlFetchApp.fetch(getFirestoreUrl(path), {
    headers: { 'Authorization': 'Bearer ' + getAuthToken() },
    muteHttpExceptions: true
  });
  return JSON.parse(response.getContentText());
}

function firestoreAdd(collection, data) {
  const firestoreData = { fields: objectToFirestore(data) };
  const response = UrlFetchApp.fetch(getFirestoreUrl(collection), {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + getAuthToken(), 'Content-Type': 'application/json' },
    payload: JSON.stringify(firestoreData),
    muteHttpExceptions: true
  });
  return JSON.parse(response.getContentText());
}

function firestoreQuery(collection, field, op, value) {
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const query = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: op, value: { stringValue: value } } }
    }
  };
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + getAuthToken(), 'Content-Type': 'application/json' },
    payload: JSON.stringify(query),
    muteHttpExceptions: true
  });
  return JSON.parse(response.getContentText());
}

function objectToFirestore(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') fields[key] = { stringValue: val };
    else if (typeof val === 'number') fields[key] = { integerValue: val.toString() };
    else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
    else if (val instanceof Date) fields[key] = { timestampValue: val.toISOString() };
    else if (Array.isArray(val)) {
      fields[key] = {
        arrayValue: {
          values: val.map(item => {
            if (typeof item === 'string') return { stringValue: item };
            if (typeof item === 'object') return { mapValue: { fields: objectToFirestore(item) } };
            return { stringValue: String(item) };
          })
        }
      };
    } else if (val === null || val === undefined) fields[key] = { nullValue: null };
  }
  return fields;
}

function scanGmailForSignatures() {
  Logger.log('🔍 מתחיל סריקת Gmail...');
  const searchQuery = `from:${CONFIG.SENDER_FILTER} OR (subject:(חתימה דיגיטלית) from:${CONFIG.SENDER_FILTER})`;
  let threads;
  try {
    threads = GmailApp.search(searchQuery, 0, CONFIG.MAX_THREADS);
  } catch (e) {
    threads = GmailApp.search(`"nurit-sp@ramat-gan.muni.il" "חתימה"`, 0, CONFIG.MAX_THREADS);
  }

  Logger.log(`נמצאו ${threads.length} שרשורים`);
  let newCount = 0;
  const driveFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const message of messages) {
      const messageId = message.getId();
      const existing = firestoreQuery('signatures', 'messageId', 'EQUAL', messageId);
      if (existing && existing.length > 0 && existing[0].document) continue;

      const body = message.getPlainBody() || '';
      const subject = message.getSubject() || '';
      const hasKeyword = CONFIG.KEYWORDS.some(kw => body.includes(kw) || subject.includes(kw));
      if (!hasKeyword) continue;

      Logger.log(`📩 עיבוד: ${subject}`);

      const files = [];
      const attachments = message.getAttachments();
      for (const att of attachments) {
        try {
          const fileName = att.getName();
          if (fileName.match(/\.(pdf|doc|docx|dwg|dxf|png|jpg|jpeg)$/i)) {
            const driveFile = driveFolder.createFile(att.copyBlob());
            driveFile.setName(`${Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd')}_${fileName}`);
            driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            files.push({ name: fileName, url: driveFile.getUrl(), driveId: driveFile.getId() });
            Logger.log(`  📄 קובץ: ${fileName}`);
          }
        } catch (e) { Logger.log(`  ⚠️ שגיאה: ${e.message}`); }
      }

      const recipients = extractRecipients(message);
      const fromName = extractSenderName(message);

      const result = firestoreAdd('signatures', {
        subject: cleanSubject(subject), from: fromName, fromEmail: CONFIG.SENDER_FILTER,
        recipients, files, notes: '', status: 'pending', source: 'gmail',
        messageId, threadId: thread.getId(), createdAt: new Date(), emailDate: message.getDate()
      });

      if (result.name) { newCount++; Logger.log('  ✅ נשמר'); }
      else Logger.log(`  ❌ שגיאה: ${JSON.stringify(result)}`);
    }
  }

  Logger.log(`🏁 סריקה הסתיימה. ${newCount} חדשות.`);
  if (newCount > 0) sendNewTaskNotification(newCount);
}

function extractRecipients(message) {
  const recipients = [];
  const seen = new Set();
  const allRecipients = `${message.getTo() || ''}, ${message.getCc() || ''}`;
  const pattern = /([^,<]+?)?\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/g;
  let match;
  while ((match = pattern.exec(allRecipients)) !== null) {
    const email = match[2].trim().toLowerCase();
    const name = match[1] ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    if (email === CONFIG.REMINDER_EMAIL.toLowerCase()) continue;
    if (email === CONFIG.SENDER_FILTER.toLowerCase()) continue;
    if (email.includes('mazcirut@')) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push({ name: name || email.split('@')[0], email });
  }
  return recipients;
}

function cleanSubject(subject) {
  return subject.replace(/^(FW:|Fw:|fw:|RE:|Re:|re:)\s*/gi, '').replace(/^(FW:|Fw:|fw:|RE:|Re:|re:)\s*/gi, '').trim();
}

function extractSenderName(message) {
  const match = message.getFrom().match(/^(.+?)\s*</);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : 'נורית שפרלינג';
}

function sendDailyReminder() {
  Logger.log('📬 בודק ממתינים לתזכורת...');
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const query = {
    structuredQuery: {
      from: [{ collectionId: 'signatures' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } },
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }]
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + getAuthToken(), 'Content-Type': 'application/json' },
    payload: JSON.stringify(query), muteHttpExceptions: true
  });

  const results = JSON.parse(response.getContentText());
  const pendingTasks = results.filter(r => r.document);
  if (pendingTasks.length === 0) { Logger.log('✅ אין ממתינים.'); return; }

  let html = `<div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #1B4332; color: white; padding: 20px; border-radius: 12px 12px 0 0;">
      <h2 style="margin: 0;">✍️ תזכורת: ${pendingTasks.length} חתימות ממתינות</h2>
      <p style="margin: 5px 0 0; opacity: 0.8;">מעקב חתימות דיגיטליות — אגף שפ"ע</p>
    </div>
    <div style="background: white; padding: 20px; border: 1px solid #E0DCD5; border-top: none; border-radius: 0 0 12px 12px;">`;

  for (const item of pendingTasks) {
    const fields = item.document.fields;
    html += `<div style="padding: 12px; margin-bottom: 10px; background: #FDF6E8; border-radius: 8px; border-right: 3px solid #D4A843;">
      <strong>${fields.subject?.stringValue || 'ללא נושא'}</strong><br>
      <span style="color: #666; font-size: 13px;">מ: ${fields.from?.stringValue || ''} | ${fields.files?.arrayValue?.values?.length || 0} קבצים</span>
    </div>`;
  }

  const appUrl = 'https://eyaltikva-ui.github.io/signature-tracker/';
  html += `<div style="margin-top: 20px; text-align: center;">
    <a href="${appUrl}" style="display: inline-block; background: #1B4332; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold;">פתח מעקב חתימות</a>
  </div></div></div>`;

  GmailApp.sendEmail(CONFIG.REMINDER_EMAIL,
    `⏳ ${pendingTasks.length} חתימות דיגיטליות ממתינות`,
    `יש לך ${pendingTasks.length} חתימות ממתינות. פתח: ${appUrl}`,
    { htmlBody: html, name: 'מעקב חתימות דיגיטליות' }
  );
  Logger.log(`📧 תזכורת נשלחה.`);
}

function sendNewTaskNotification(count) {
  const appUrl = 'https://eyaltikva-ui.github.io/signature-tracker/';
  GmailApp.sendEmail(CONFIG.REMINDER_EMAIL,
    `🆕 ${count} בקשות חתימה חדשות`,
    `נכנסו ${count} בקשות חתימה חדשות. פתח: ${appUrl}`,
    { name: 'מעקב חתימות דיגיטליות' }
  );
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanGmailForSignatures').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sendDailyReminder').timeBased().atHour(8).everyDays(1).inTimezone('Asia/Jerusalem').create();
  Logger.log('✅ Triggers הוגדרו!');
}

function testAddSampleTask() {
  const result = firestoreAdd('signatures', {
    subject: 'ארנון 27 + ארנון 29 - בקשות להיתר - תאום פתרון אשפה',
    from: 'נורית שפרלינג', fromEmail: 'nurit-sp@ramat-gan.muni.il',
    recipients: [
      { name: 'אדוה מורי', email: 'adva@ksa-studio.com' },
      { name: 'קורן שחר', email: 'koren@ksa-studio.com' },
      { name: 'Michael Fischer', email: 'michael@mfpm.co.il' },
      { name: 'Adi Dan', email: 'adi@mfpm.co.il' }
    ],
    files: [
      { name: 'ח. אשפה 27 1-50.pdf', url: '#', driveId: '' },
      { name: 'ח. אשפה 29 1-50.pdf', url: '#', driveId: '' }
    ],
    notes: 'הנספח נבדק — אין מניעה לאשר. אנא חתימה דיגיטלית והעברה למכותבים.',
    status: 'pending', source: 'test', messageId: 'test-' + Date.now(), createdAt: new Date()
  });
  Logger.log('Result: ' + JSON.stringify(result));
}
