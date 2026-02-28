const CONFIG = {
  FIREBASE_PROJECT_ID: 'signature-tracker-6ca1e',
  DRIVE_FOLDER_ID: '155VRDwcInG32Tl-0tTfm_rMmGgfAOhRL',
  REMINDER_EMAIL: 'eyal-t@ramat-gan.muni.il',
  SENDER_FILTER: 'nurit-sp@ramat-gan.muni.il',
  FORWARDER_EMAIL: 'eyal-t@ramat-gan.muni.il',
  MY_EMAIL: 'eyaltikva@gmail.com',
  STAMP_IMAGE_ID: '1iU8-8u0U-3mtDV3MTOQJ-fa_GpxK81al',
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

  // חיפוש 1: מיילים ישירים מנורית (אם יש)
  // חיפוש 2: מיילים מועברים מהחשבון העירוני עם מילות מפתח
  // חיפוש 3: מיילים שמכילים את השם/מייל של נורית (העברה ידנית)
  const queries = [
    `from:${CONFIG.SENDER_FILTER}`,
    `from:${CONFIG.FORWARDER_EMAIL} (subject:(חתימה) OR subject:(Fwd) OR subject:(FW))`,
    `"${CONFIG.SENDER_FILTER}" (subject:(חתימה) OR subject:(היתר) OR subject:(אנא חתימה))`
  ];

  const allThreadIds = new Set();
  let allThreads = [];

  for (const q of queries) {
    try {
      const threads = GmailApp.search(q, 0, CONFIG.MAX_THREADS);
      for (const thread of threads) {
        if (!allThreadIds.has(thread.getId())) {
          allThreadIds.add(thread.getId());
          allThreads.push(thread);
        }
      }
    } catch (e) {
      Logger.log(`⚠️ שגיאה בחיפוש: ${e.message}`);
    }
  }

  Logger.log(`נמצאו ${allThreads.length} שרשורים`);
  let newCount = 0;
  const driveFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);

  for (const thread of allThreads) {
    const messages = thread.getMessages();
    for (const message of messages) {
      const messageId = message.getId();
      const existing = firestoreQuery('signatures', 'messageId', 'EQUAL', messageId);
      if (existing && existing.length > 0 && existing[0].document) continue;

      const body = message.getPlainBody() || '';
      const subject = message.getSubject() || '';
      const senderEmail = message.getFrom().match(/<(.+?)>/) ? message.getFrom().match(/<(.+?)>/)[1].toLowerCase() : message.getFrom().toLowerCase();

      // בדיקה: האם מייל מנורית (ישיר), או מועבר מהחשבון העירוני, או מכיל את נורית בגוף
      const isFromNurit = senderEmail.includes(CONFIG.SENDER_FILTER);
      const isForwarded = senderEmail.includes(CONFIG.FORWARDER_EMAIL) || senderEmail.includes(CONFIG.MY_EMAIL);
      const bodyMentionsNurit = body.includes(CONFIG.SENDER_FILTER) || body.includes('נורית שפרלינג') || body.includes('נורית');

      if (!isFromNurit && !isForwarded && !bodyMentionsNurit) continue;

      // סינון מחמיר: חייב להכיל מילת מפתח של חתימה דיגיטלית
      const hasKeyword = CONFIG.KEYWORDS.some(kw => body.includes(kw) || subject.includes(kw));
      if (!hasKeyword) continue;

      Logger.log(`📩 עיבוד: ${subject} (${isFromNurit ? 'ישיר' : 'מועבר'})`);

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

      // חילוץ שם השולח: מנורית ישירות, או מגוף ההעברה
      let fromName, fromEmail;
      if (isFromNurit) {
        fromName = extractSenderName(message);
        fromEmail = CONFIG.SENDER_FILTER;
      } else {
        // מייל מועבר — מנסים לחלץ את השולח המקורי מגוף ההודעה
        fromName = extractOriginalSender(body) || 'נורית שפרלינג';
        fromEmail = extractOriginalEmail(body) || CONFIG.SENDER_FILTER;
      }

      const result = firestoreAdd('signatures', {
        subject: cleanSubject(subject), from: fromName, fromEmail: fromEmail,
        recipients, files, notes: '', status: 'pending', source: isFromNurit ? 'gmail' : 'forwarded',
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
    if (email === CONFIG.MY_EMAIL.toLowerCase()) continue;
    if (email === CONFIG.FORWARDER_EMAIL.toLowerCase()) continue;
    if (email.includes('mazcirut@')) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push({ name: name || email.split('@')[0], email });
  }
  return recipients;
}

function extractOriginalSender(body) {
  // ניסיון לחלץ שם שולח מקורי מגוף מייל מועבר
  // תבניות נפוצות: "מאת: נורית שפרלינג", "From: Nurit", "---------- Forwarded message ----------"
  const patterns = [
    /מאת:\s*([^\n<]+?)[\s]*[<\n]/,
    /From:\s*([^\n<]+?)[\s]*[<\n]/,
    /מ:\s*([^\n<]+?)[\s]*[<\n]/
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function extractOriginalEmail(body) {
  // ניסיון לחלץ מייל שולח מקורי מגוף מייל מועבר
  const patterns = [
    /מאת:.*?<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/,
    /From:.*?<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/,
    /מ:.*?<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m) return m[1].toLowerCase();
  }
  // אם לא מצאנו בתבנית, מחפשים את המייל של נורית בגוף
  if (body.includes(CONFIG.SENDER_FILTER)) return CONFIG.SENDER_FILTER;
  return null;
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

// ==========================================
// חתימה דיגיטלית אוטומטית — ZgaPdfSigner
// ==========================================

function firestoreUpdate(docPath, data) {
  const firestoreData = { fields: objectToFirestore(data) };
  const updateMask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const url = `${getFirestoreUrl(docPath)}?${updateMask}`;
  const response = UrlFetchApp.fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + getAuthToken(), 'Content-Type': 'application/json' },
    payload: JSON.stringify(firestoreData),
    muteHttpExceptions: true
  });
  return JSON.parse(response.getContentText());
}

async function signPdfBlob(pdfBlob) {
  // טעינת ספריית ZgaPdfSigner
  pdfkit.loadZga(globalThis);

  // קריאת התעודה הדיגיטלית מ-Script Properties
  const props = PropertiesService.getScriptProperties();
  const p12Base64 = props.getProperty('P12_CERT');
  const p12Password = props.getProperty('P12_PASSWORD');

  if (!p12Base64 || !p12Password) {
    throw new Error('חסרים P12_CERT או P12_PASSWORD ב-Script Properties');
  }

  const certBytes = Utilities.base64Decode(p12Base64);

  // טעינת תמונת החותמת מ-Drive
  let stampImgData = null;
  try {
    const stampFile = DriveApp.getFileById(CONFIG.STAMP_IMAGE_ID);
    stampImgData = stampFile.getBlob().getBytes();
    Logger.log('🖼️ תמונת חותמת נטענה בהצלחה');
  } catch (e) {
    Logger.log('⚠️ לא ניתן לטעון תמונת חותמת: ' + e.message);
  }

  const sopt = {
    p12cert: certBytes,
    pwd: p12Password,
    signdate: '1',
    reason: 'אושר — אגף שפע, עיריית רמת גן',
    location: 'רמת גן',
    contact: 'eyal-t@ramat-gan.muni.il',
    ltv: 0
  };

  // הוספת חותמת ויזואלית אם התמונה נטענה
  if (stampImgData) {
    sopt.drawinf = {
      area: {
        x: 30,
        y: 30,
        w: 150,
        h: 180
      },
      imgInfo: {
        imgData: stampImgData,
        imgType: 'png'
      }
    };
  }

  const signer = new Zga.PdfSigner(sopt);
  const signedBytes = await signer.sign(pdfBlob.getBytes());
  return Utilities.newBlob([...signedBytes], 'application/pdf');
}

async function autoSignPendingTasks() {
  Logger.log('🖊️ מתחיל חתימה אוטומטית...');

  // שליפת משימות ממתינות מ-Firestore
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const query = {
    structuredQuery: {
      from: [{ collectionId: 'signatures' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } }
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + getAuthToken(), 'Content-Type': 'application/json' },
    payload: JSON.stringify(query), muteHttpExceptions: true
  });

  const results = JSON.parse(response.getContentText());
  const pendingTasks = results.filter(r => r.document);

  if (pendingTasks.length === 0) {
    Logger.log('✅ אין משימות ממתינות.');
    return;
  }

  Logger.log(`📋 נמצאו ${pendingTasks.length} משימות ממתינות`);
  const driveFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  let signedCount = 0;

  for (const item of pendingTasks) {
    const fields = item.document.fields;
    const docId = item.document.name.split('/').pop();
    const subject = fields.subject?.stringValue || 'ללא נושא';
    const fromEmail = fields.fromEmail?.stringValue || CONFIG.SENDER_FILTER;
    const fromName = fields.from?.stringValue || '';

    Logger.log(`🔄 מעבד: ${subject}`);

    // בדיקה שיש קבצים
    const filesArray = fields.files?.arrayValue?.values || [];
    if (filesArray.length === 0) {
      Logger.log('  ⚠️ אין קבצים — מדלג');
      continue;
    }

    const signedFiles = [];
    let allSigned = true;

    for (const fileVal of filesArray) {
      const fileFields = fileVal.mapValue?.fields;
      if (!fileFields) continue;

      const fileName = fileFields.name?.stringValue || 'document.pdf';
      const driveId = fileFields.driveId?.stringValue;

      // רק PDFs ניתנים לחתימה דיגיטלית
      if (!fileName.toLowerCase().endsWith('.pdf') || !driveId) {
        Logger.log(`  ⏭️ דילוג על ${fileName} (לא PDF או חסר driveId)`);
        signedFiles.push({ name: fileName, driveId: driveId || '', url: fileFields.url?.stringValue || '' });
        continue;
      }

      try {
        const pdfFile = DriveApp.getFileById(driveId);
        const pdfBlob = pdfFile.getBlob();

        Logger.log(`  ✍️ חותם: ${fileName}`);
        const signedBlob = await signPdfBlob(pdfBlob);
        signedBlob.setName(`חתום_${fileName}`);

        // שמירת הקובץ החתום ב-Drive
        const signedDriveFile = driveFolder.createFile(signedBlob);
        signedDriveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

        signedFiles.push({
          name: `חתום_${fileName}`,
          driveId: signedDriveFile.getId(),
          url: signedDriveFile.getUrl()
        });

        Logger.log(`  ✅ נחתם ונשמר: חתום_${fileName}`);
      } catch (e) {
        Logger.log(`  ❌ שגיאה בחתימת ${fileName}: ${e.message}`);
        allSigned = false;
        signedFiles.push({ name: fileName, driveId: driveId, url: fileFields.url?.stringValue || '' });
      }
    }

    if (!allSigned) {
      Logger.log(`  ⚠️ לא כל הקבצים נחתמו — ממשיך לבא`);
      continue;
    }

    // שליחת הקבצים החתומים בחזרה
    try {
      sendSignedFiles(subject, fromEmail, fromName, signedFiles, fields.recipients);
      Logger.log(`  📧 נשלח בחזרה ל-${fromEmail}`);
    } catch (e) {
      Logger.log(`  ❌ שגיאה בשליחה: ${e.message}`);
      continue;
    }

    // עדכון סטטוס ל-completed
    firestoreUpdate(`signatures/${docId}`, {
      status: 'completed',
      signedAt: new Date(),
      signedFiles: signedFiles
    });

    signedCount++;
    Logger.log(`  ✅ הושלם: ${subject}`);
  }

  Logger.log(`🏁 חתימה אוטומטית הסתיימה. ${signedCount} משימות נחתמו.`);
}

function sendSignedFiles(subject, toEmail, fromName, signedFiles, recipientsField) {
  // איסוף כל הנמענים (שולח מקורי + נמענים נוספים)
  const allRecipients = new Set();
  allRecipients.add(toEmail);

  if (recipientsField?.arrayValue?.values) {
    for (const r of recipientsField.arrayValue.values) {
      const email = r.mapValue?.fields?.email?.stringValue;
      if (email) allRecipients.add(email);
    }
  }

  // הכנת קבצים מצורפים
  const attachments = [];
  for (const f of signedFiles) {
    if (f.driveId && f.name.startsWith('חתום_')) {
      try {
        attachments.push(DriveApp.getFileById(f.driveId).getBlob());
      } catch (e) { Logger.log(`  ⚠️ לא ניתן לצרף ${f.name}`); }
    }
  }

  const linksHtml = signedFiles
    .filter(f => f.url && f.name.startsWith('חתום_'))
    .map(f => `<a href="${f.url}">${f.name}</a>`)
    .join('<br>');

  const htmlBody = `<div dir="rtl" style="font-family: Arial, sans-serif;">
    <div style="background: #1B4332; color: white; padding: 15px 20px; border-radius: 10px 10px 0 0;">
      <h3 style="margin: 0;">✅ מסמך נחתם דיגיטלית</h3>
    </div>
    <div style="background: white; padding: 20px; border: 1px solid #E0DCD5; border-radius: 0 0 10px 10px;">
      <p><strong>נושא:</strong> ${subject}</p>
      <p>המסמכים הבאים נחתמו בחתימה דיגיטלית:</p>
      <div style="background: #F0FFF4; padding: 12px; border-radius: 8px; margin: 10px 0;">
        ${linksHtml}
      </div>
      <p style="color: #666; font-size: 12px;">נחתם אוטומטית — אגף שפ"ע, עיריית רמת גן</p>
    </div>
  </div>`;

  const recipientList = [...allRecipients].join(',');

  GmailApp.sendEmail(recipientList, `✅ נחתם: ${subject}`,
    `המסמכים נחתמו דיגיטלית. ${signedFiles.filter(f => f.url).map(f => f.url).join('\n')}`,
    {
      htmlBody: htmlBody,
      attachments: attachments,
      name: 'חתימות דיגיטליות — עיריית רמת גן'
    }
  );
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanGmailForSignatures').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sendDailyReminder').timeBased().atHour(8).everyDays(1).inTimezone('Asia/Jerusalem').create();
  ScriptApp.newTrigger('autoSignPendingTasks').timeBased().everyMinutes(15).create();
  Logger.log('✅ Triggers הוגדרו (כולל חתימה אוטומטית כל 15 דקות)!');
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

async function testSignPdf() {
  // חיפוש קובץ PDF בתיקייה
  const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const files = folder.getFilesByType('application/pdf');
  if (!files.hasNext()) {
    Logger.log('❌ לא נמצאו קבצי PDF בתיקייה');
    return;
  }
  const pdfFile = files.next();
  Logger.log('📄 חותם את: ' + pdfFile.getName());

  const signedBlob = await signPdfBlob(pdfFile.getBlob());
  signedBlob.setName('TEST_SIGNED_' + pdfFile.getName());

  const savedFile = folder.createFile(signedBlob);
  Logger.log('✅ קובץ חתום נשמר: ' + savedFile.getName());
  Logger.log('🔗 ' + savedFile.getUrl());
}
