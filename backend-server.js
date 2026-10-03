const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('./functions/node_modules/firebase-admin');
const { Firestore } = require('@google-cloud/firestore');
const { OAuth2Client } = require('google-auth-library');

// Load local server .env configuration if present (never committed to git)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (envErr) {
  console.warn('[Backend] Notice loading .env file:', envErr.message);
}

const PORT = process.env.BACKEND_PORT || 3001;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'clound-based-attendance';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';

// 1. Initialize Firebase Admin SDK
let db = null;
let FieldValue = null;
const FIREBASE_CLI_CLIENT_ID = process.env.FIREBASE_CLI_CLIENT_ID || '';
const FIREBASE_CLI_CLIENT_SECRET = process.env.FIREBASE_CLI_CLIENT_SECRET || '';

try {
  const credPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (fs.existsSync(credPath)) {
    const credData = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const refreshToken = credData.tokens?.refresh_token;
    const token = credData.tokens?.access_token;

    const canRefreshCliToken = Boolean(refreshToken && FIREBASE_CLI_CLIENT_ID && FIREBASE_CLI_CLIENT_SECRET);
    if (token || canRefreshCliToken) {
      const authClient = new OAuth2Client(FIREBASE_CLI_CLIENT_ID, FIREBASE_CLI_CLIENT_SECRET);
      if (refreshToken) {
        authClient.setCredentials({ refresh_token: refreshToken });
      } else {
        authClient.setCredentials({ access_token: token });
      }

      admin.initializeApp({
        projectId: PROJECT_ID,
        credential: {
          getAccessToken: async () => {
            const tokenRes = await authClient.getAccessToken();
            return { access_token: tokenRes.token || token, expires_in: 3600 };
          }
        }
      });
      db = new Firestore({
        projectId: PROJECT_ID,
        authClient: authClient
      });
      FieldValue = db.constructor.FieldValue;
      console.log('[Backend] Initialized Firebase Admin & Firestore via auto-refreshing CLI token');
    }
  }
} catch (initErr) {
  console.warn('[Backend] CLI token init failed, attempting standard initializeApp:', initErr.message);
}

const existingApps = typeof admin.getApps === 'function' ? admin.getApps() : (admin.apps || []);
if (!existingApps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
  FieldValue = db.constructor.FieldValue || admin.firestore.FieldValue;
  console.log('[Backend] Initialized standard Firebase Admin');
}

if (!FieldValue && db) {
  FieldValue = (db.constructor && db.constructor.FieldValue) || (admin.firestore ? admin.firestore.FieldValue : require('@google-cloud/firestore').FieldValue);
}

async function isAdminAuth(decodedToken) {
  if (!decodedToken) return false;
  if (decodedToken.admin === true) return true;
  const uid = decodedToken.uid || decodedToken.user_id;
  if (!uid) return false;
  try {
    const adminDoc = await db.collection('admins').doc(uid).get();
    return adminDoc.exists && adminDoc.data()?.active !== false;
  } catch (err) {
    console.error('[Backend] Error verifying admin doc for UID:', uid, err.message);
    return false;
  }
}

async function isAuthorizedToFinalize(decodedToken, sessionId) {
  if (await isAdminAuth(decodedToken)) return true;
  const sessionSnap = await db.collection('attendanceSessions').doc(sessionId).get();
  if (!sessionSnap.exists) return false;
  const session = sessionSnap.data();
  const uid = decodedToken.uid || decodedToken.user_id;
  if (session.facultyUid === uid || session.facultyId === uid) return true;
  if (session.facultyId && decodedToken.email) {
    const facultySnap = await db.collection('faculty').doc(session.facultyId).get();
    return facultySnap.exists && facultySnap.data().email === decodedToken.email;
  }
  return false;
}

function triggerPasswordResetEmail(email) {
  return new Promise(resolve => {
    const postData = JSON.stringify({
      requestType: 'PASSWORD_RESET',
      email: email
    });
    const req = https.request(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          try {
            const errObj = JSON.parse(data);
            resolve({ ok: false, error: errObj.error?.message || `HTTP ${res.statusCode}` });
          } catch(e) {
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          }
        }
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timeout' }); });
    req.write(postData);
    req.end();
  });
}

async function loadDepartmentsMap() {
  const snap = await db.collection('departments').get();
  const map = new Map();
  snap.forEach(doc => {
    const data = doc.data();
    const id = doc.id;
    const name = (data.name || id).trim();
    const normalizedName = (data.normalizedName || name).toLowerCase();
    const item = { id, name, normalizedName };
    map.set(id.toLowerCase(), item);
    map.set(normalizedName, item);
    map.set(name.toLowerCase(), item);
  });
  return map;
}

// =========================================================================
// PARENT SMS & ABSENCE NOTIFICATION SERVICE (DEMO / MOCK ARCHITECTURE)
// =========================================================================
function validateAndNormalizeIndianPhone(phoneInput) {
  if (!phoneInput || typeof phoneInput !== 'string') {
    return { valid: false, error: 'Parent mobile number is required.', normalized: '' };
  }
  const trimmed = phoneInput.trim();
  if (!trimmed) {
    return { valid: false, error: 'Parent mobile number is required.', normalized: '' };
  }
  let cleaned = trimmed.replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('+91')) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }

  const indianMobileRegex = /^[6-9]\d{9}$/;
  if (!indianMobileRegex.test(cleaned)) {
    return {
      valid: false,
      error: 'Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).',
      normalized: ''
    };
  }

  return { valid: true, error: null, normalized: cleaned };
}

function maskPhoneNumber(phone) {
  if (!phone) return 'Not Provided';
  const clean = String(phone).replace(/\D/g, '');
  const digits = clean.startsWith('91') && clean.length === 12 ? clean.slice(2) : clean;
  if (digits.length >= 10) {
    const firstTwo = digits.slice(0, 2);
    const lastTwo = digits.slice(-2);
    return `${firstTwo}${'*'.repeat(digits.length - 4)}${lastTwo}`;
  }
  return '******';
}

const SMS_CONFIG = {
  providerMode: process.env.SMS_PROVIDER_MODE || 'mock',
  apiKey: process.env.SMS_API_KEY || ''
};

// -------------------------------------------------------------------------
// SMS Gateway Utilities & Extensible Configuration
// -------------------------------------------------------------------------

function makeHttpsRequest(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: options.timeout || 10000
    };

    const req = https.request(reqOptions, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          parsed = body;
        }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SMS gateway request timed out after 10000ms'));
    });

    req.on('error', err => {
      reject(err);
    });

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function getSmsConfig() {
  const providerMode = (process.env.SMS_PROVIDER || process.env.SMS_PROVIDER_MODE || 'mock').trim().toLowerCase();
  const apiKey = (process.env.SMS_API_KEY || process.env.MSG91_AUTH_KEY || '').trim();
  const senderId = (process.env.SMS_SENDER_ID || process.env.MSG91_SENDER_ID || 'CITSYS').trim().toUpperCase();
  const templateId = (process.env.SMS_TEMPLATE_ID || process.env.MSG91_TEMPLATE_ID || process.env.MSG91_FLOW_ID || '').trim();
  const dltTeId = (process.env.SMS_DLT_TE_ID || process.env.MSG91_DLT_TE_ID || '').trim();
  const entityId = (process.env.SMS_ENTITY_ID || process.env.MSG91_ENTITY_ID || '').trim();

  return {
    providerMode, // 'mock' or 'msg91'
    apiKey,
    senderId,
    templateId,
    dltTeId,
    entityId
  };
}

class SmsService {
  constructor(config = null, httpRequester = null) {
    this._explicitConfig = config;
    this._httpRequester = httpRequester || makeHttpsRequest;
  }

  get config() {
    return this._explicitConfig || getSmsConfig();
  }

  async sendAbsenceNotification({ parentPhone, parentName, studentName, subjectName, date, sessionId, studentUid }) {
    const maskedPhone = maskPhoneNumber(parentPhone);
    const message = `CIT Alert: Your ward ${studentName} was marked ABSENT for ${subjectName} on ${date}. CIT Attendance Dept.`;
    const cfg = this.config;
    const providerMode = (cfg.providerMode || 'mock').toLowerCase();

    // 1. MOCK PROVIDER (Default safe mode - zero credits, zero external calls)
    if (providerMode === 'mock') {
      console.log(`[Demo SMS] Dispatched mock SMS to ${maskedPhone} for absent student ${studentName} (${subjectName}, ${date})`);
      return {
        success: true,
        mode: 'mock',
        status: 'demo_sent',
        maskedPhone,
        message
      };
    }

    // 2. REAL MSG91 PROVIDER (Flow API v5 & India DLT Compliance)
    if (providerMode === 'msg91') {
      return await this._sendViaMsg91({
        parentPhone,
        parentName,
        studentName,
        subjectName,
        date,
        message,
        sessionId,
        studentUid
      });
    }

    return {
      success: false,
      mode: providerMode,
      status: 'failed',
      maskedPhone,
      message,
      error: `Unsupported SMS providerMode: ${providerMode}`
    };
  }

  async _sendViaMsg91({ parentPhone, studentName, subjectName, date, message }) {
    const cfg = this.config;
    const maskedPhone = maskPhoneNumber(parentPhone);

    // 1. Validate API Key
    if (!cfg.apiKey) {
      return {
        success: false,
        status: 'failed',
        mode: 'msg91',
        maskedPhone,
        message,
        error: 'Real SMS provider is not configured. MSG91 API key is missing on the server.'
      };
    }

    // 2. India DLT Requirement: Flow Template ID is mandatory
    if (!cfg.templateId) {
      return {
        success: false,
        status: 'failed',
        mode: 'msg91',
        maskedPhone,
        message,
        error: 'SMS provider rejected the message. Check the DLT sender/template configuration (SMS_TEMPLATE_ID is required for India DLT delivery).'
      };
    }

    // 3. Indian Phone Normalization (require 91 country code for telecom routing)
    const cleanDigits = String(parentPhone || '').replace(/\D/g, '');
    const mobileWithCode = (cleanDigits.startsWith('91') && cleanDigits.length === 12)
      ? cleanDigits
      : `91${cleanDigits}`;

    // 4. Construct MSG91 Flow Payload supporting both named and generic variables
    const payload = {
      template_id: cfg.templateId,
      sender: cfg.senderId || 'CITSYS',
      short_url: '0',
      recipients: [
        {
          mobiles: mobileWithCode,
          student_name: studentName,
          subject_name: subjectName,
          date: date,
          var1: studentName,
          var2: subjectName,
          var3: date
        }
      ]
    };

    if (cfg.dltTeId) {
      payload.DLT_TE_ID = cfg.dltTeId;
    }
    if (cfg.entityId) {
      payload.entity_id = cfg.entityId;
    }

    try {
      const postData = JSON.stringify(payload);
      const res = await this._httpRequester('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
          'authkey': cfg.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000
      }, postData);

      const resData = res.data || {};
      const resType = String(resData.type || '').toLowerCase();
      const resMsg = typeof resData === 'string' ? resData : String(resData.message || '');

      // Check Authentication Rejection
      if (res.status === 401 || /auth|invalid key|unauthorized/i.test(resMsg)) {
        return {
          success: false,
          status: 'failed',
          mode: 'msg91',
          maskedPhone,
          message,
          error: 'SMS provider authentication failed. Check the server SMS credentials.'
        };
      }

      // Check DLT / Template Rejection
      if (res.status === 400 || res.status === 422 || resType === 'error') {
        if (/template|dlt|sender|header|pe_id/i.test(resMsg)) {
          return {
            success: false,
            status: 'failed',
            mode: 'msg91',
            maskedPhone,
            message,
            error: 'SMS provider rejected the message. Check the DLT sender/template configuration.'
          };
        }
        return {
          success: false,
          status: 'failed',
          mode: 'msg91',
          maskedPhone,
          message,
          error: `SMS provider error: ${resMsg || 'Message rejected by gateway'}`
        };
      }

      // Check Successful Acceptance (HTTP 200 or 202)
      if (res.status >= 200 && res.status < 300 && resType !== 'error') {
        const providerRef = resData.request_id || resData.message_id || 'msg91_accepted';
        console.log(`[MSG91 SMS] Successfully dispatched absence alert to ${maskedPhone} for ${studentName} (Ref: ${providerRef})`);
        return {
          success: true,
          status: 'sent',
          mode: 'msg91',
          maskedPhone,
          message,
          providerRef
        };
      }

      return {
        success: false,
        status: 'failed',
        mode: 'msg91',
        maskedPhone,
        message,
        error: `SMS provider returned unexpected HTTP status: ${res.status}`
      };
    } catch (netErr) {
      console.error(`[MSG91 SMS Network Error] Failed sending to ${maskedPhone}:`, netErr.message);
      return {
        success: false,
        status: 'failed',
        mode: 'msg91',
        maskedPhone,
        message,
        error: `Failed to connect to SMS gateway: ${netErr.message}`
      };
    }
  }
}

const smsService = new SmsService();

async function finalizeAttendanceSms({ sessionId, subjectId, facultyUid, customSmsService = null }) {
  if (!sessionId) throw new Error('sessionId is required');
  const activeSmsService = customSmsService || smsService;

  // 1. Get Session doc
  const sessionRef = db.collection('attendanceSessions').doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const sessionData = sessionSnap.data();
  const subjId = subjectId || sessionData.subjectId;
  const subjName = sessionData.subjectName || 'Course Subject';
  const sessionDate = sessionData.date || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Mark session inactive if still active
  if (sessionData.active) {
    await sessionRef.update({ active: false });
  }

  // 2. Fetch subject to get enrolled roster
  const subjectSnap = await db.collection('subjects').doc(subjId).get();
  if (!subjectSnap.exists) {
    throw new Error(`Subject ${subjId} not found`);
  }
  const subjectData = subjectSnap.data();
  let enrolledStudents = Array.isArray(subjectData.enrolledRoster) ? subjectData.enrolledRoster : [];
  if (!enrolledStudents.length && Array.isArray(subjectData.studentIds)) {
    enrolledStudents = subjectData.studentIds.map(id => ({ id, name: 'Student', usn: '' }));
  }

  // 3. Fetch attendance records for this session
  const attSnap = await db.collection('attendance').where('sessionId', '==', sessionId).get();
  const presentSet = new Set();
  attSnap.forEach(doc => {
    const a = doc.data();
    if (a.studentUid) presentSet.add(a.studentUid);
    if (a.studentId) presentSet.add(a.studentId);
  });

  // 4. Calculate absent students (Enrolled - Present)
  const absentStudents = enrolledStudents.filter(stu => {
    const stuId = stu.id || stu.uid;
    return !presentSet.has(stuId);
  });

  const presentCount = enrolledStudents.length - absentStudents.length;
  const absentCount = absentStudents.length;

  let newlySent = 0;
  let newlyFailed = 0;
  let newlyDemoSent = 0;
  let previouslySent = 0;
  const notificationResults = [];

  for (const stu of absentStudents) {
    const stuUid = stu.id || stu.uid;
    const notificationDocId = `${sessionId}_${stuUid}_absence`;
    const logRef = db.collection('notificationLogs').doc(notificationDocId);
    const existingLog = await logRef.get();

    // Duplicate check: If already successfully sent or demo_sent, DO NOT resend!
    if (existingLog.exists) {
      const logData = existingLog.data();
      if (logData.status === 'sent' || logData.status === 'demo_sent') {
        previouslySent++;
        notificationResults.push({
          studentUid: stuUid,
          studentName: logData.studentName || stu.name,
          usn: logData.usn || stu.usn || '',
          parentPhoneMasked: logData.parentPhoneMasked || '******',
          status: logData.status,
          provider: logData.provider || logData.providerMode || 'mock',
          isNew: false
        });
        continue;
      }
    }

    // Fetch student details from Firestore students collection
    const stuSnap = await db.collection('students').doc(stuUid).get();
    const stuData = stuSnap.exists ? stuSnap.data() : {};
    const studentName = stuData.name || stu.name || 'Student';
    const usn = stuData.usn || stu.usn || '';
    const parentPhone = stuData.parentPhone || stuData.phone || '';
    const parentName = stuData.parentName || 'Parent/Guardian';
    const maskedPhone = maskPhoneNumber(parentPhone);

    let smsRes;
    try {
      smsRes = await activeSmsService.sendAbsenceNotification({
        parentPhone,
        parentName,
        studentName,
        subjectName: subjName,
        date: sessionDate,
        sessionId,
        studentUid: stuUid
      });
    } catch (smsEx) {
      smsRes = {
        success: false,
        status: 'failed',
        mode: activeSmsService.config.providerMode,
        maskedPhone,
        message: `CIT Alert: Your ward ${studentName} was marked ABSENT for ${subjName} on ${sessionDate}. CIT Attendance Dept.`,
        error: smsEx.message || 'SMS delivery failed unexpectedly'
      };
    }

    const finalStatus = smsRes.status || (smsRes.success ? (smsRes.mode === 'mock' ? 'demo_sent' : 'sent') : 'failed');

    const logData = {
      sessionId,
      studentUid: stuUid,
      studentName,
      usn,
      subjectId: subjId,
      subjectName: subjName,
      sessionDate,
      parentName,
      parentPhoneMasked: maskedPhone,
      notificationType: 'absence',
      provider: smsRes.mode || activeSmsService.config.providerMode || 'mock',
      providerMode: smsRes.mode || activeSmsService.config.providerMode || 'mock',
      status: finalStatus,
      message: smsRes.message,
      source: 'system_session_finalization',
      facultyUid: facultyUid || sessionData.facultyUid || '',
      error: finalStatus === 'failed' ? (smsRes.error || 'Delivery failed') : null,
      providerRef: smsRes.providerRef || null,
      createdAt: existingLog.exists ? (existingLog.data().createdAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    await logRef.set(logData);

    if (finalStatus === 'sent') newlySent++;
    else if (finalStatus === 'demo_sent') newlyDemoSent++;
    else if (finalStatus === 'failed') newlyFailed++;

    notificationResults.push({
      studentUid: stuUid,
      studentName,
      usn,
      parentPhoneMasked: maskedPhone,
      status: finalStatus,
      provider: logData.provider,
      error: logData.error,
      isNew: true
    });
  }

  return {
    success: true,
    sessionId,
    subjectId: subjId,
    subjectName: subjName,
    date: sessionDate,
    startTime: sessionData.startTime || null,
    endTime: sessionData.endTime || null,
    classNumber: sessionData.classNumber || null,
    totalEnrolled: enrolledStudents.length,
    presentCount,
    absentCount,
    notificationsGenerated: newlySent + newlyDemoSent + newlyFailed,
    sentCount: newlySent,
    failedCount: newlyFailed,
    demoCount: newlyDemoSent,
    previouslySent,
    providerMode: activeSmsService.config.providerMode,
    absentStudents: notificationResults
  };
}

async function importSingleStudent(student, departmentsMap, cachedSubjects = null) {
  const name = String(student.name || '').trim();
  const usn = String(student.usn || '').trim().toUpperCase();
  const email = String(student.email || '').trim().toLowerCase();
  const semRaw = student.sem;
  const sec = String(student.sec || '').trim().toUpperCase();
  const deptInput = String(student.dept || '').trim();

  // 1. Validation
  if (!name) {
    return { name, usn, email, status: 'failed', result: 'Invalid name', reason: 'Student name cannot be empty' };
  }
  if (!usn) {
    return { name, usn, email, status: 'failed', result: 'Invalid USN', reason: 'Student USN cannot be empty' };
  }
  const sem = parseInt(semRaw, 10);
  if (isNaN(sem) || sem < 1 || sem > 8) {
    return { name, usn, email, status: 'failed', result: 'Invalid semester', reason: 'Semester must be between 1 and 8' };
  }
  if (!sec || !['A', 'B', 'C', 'D'].includes(sec)) {
    return { name, usn, email, status: 'failed', result: 'Invalid section', reason: 'Section must be A, B, C, or D' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return { name, usn, email, status: 'failed', result: 'Invalid email', reason: 'Invalid email format' };
  }

  // Department check against existing departments
  const normalizedDeptKey = deptInput.toLowerCase();
  const matchedDept = departmentsMap.get(normalizedDeptKey);
  if (!matchedDept) {
    return { name, usn, email, status: 'failed', result: 'Department not found', reason: `Department "${deptInput}" does not match an existing department` };
  }

  const deptId = matchedDept.id;
  const deptName = matchedDept.name;

  // 2. Duplicate Checks
  try {
    // USN duplicate check
    const usnDoc = await db.collection('uniqueUSNs').doc(usn).get();
    if (usnDoc.exists) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }
    const usnSnap = await db.collection('students').where('usn', '==', usn).limit(1).get();
    if (!usnSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with USN ${usn} already exists` };
    }

    // Email duplicate check
    const emailDoc = await db.collection('uniqueEmails').doc(email).get();
    if (emailDoc.exists) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Account with email ${email} already exists` };
    }
    const emailSnap = await db.collection('students').where('email', '==', email).limit(1).get();
    if (!emailSnap.empty) {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Student with email ${email} already exists` };
    }

    // Auth user check
    try {
      const existingUser = await admin.auth().getUserByEmail(email);
      if (existingUser) {
        return { name, usn, email, status: 'skipped', result: 'Already exists', reason: `Firebase Authentication account already exists for ${email}` };
      }
    } catch (authLookupErr) {
      if (authLookupErr.code !== 'auth/user-not-found') {
        throw authLookupErr;
      }
    }
  } catch (checkErr) {
    return { name, usn, email, status: 'failed', result: 'Validation error', reason: checkErr.message || 'Error checking existing records' };
  }

  // 3. Create Firebase Authentication Account
  let authUser = null;
  try {
    authUser = await admin.auth().createUser({
      email: email,
      displayName: name
    });
  } catch (authCreateErr) {
    if (authCreateErr.code === 'auth/email-already-in-use') {
      return { name, usn, email, status: 'skipped', result: 'Already exists', reason: 'Firebase Authentication account already exists' };
    }
    return { name, usn, email, status: 'failed', result: 'Authentication account creation failed', reason: authCreateErr.message };
  }

  const uid = authUser.uid;

  // 4. Create Firestore Student Profile and Unique Index Records
  const parentName = String(student.parentName || student.guardianName || `${name}'s Parent`).trim();
  const rawParentPhone = String(student.parentPhone || student.parentMobile || student.phone || '9876543210').trim();
  const phoneVal = validateAndNormalizeIndianPhone(rawParentPhone);
  const parentPhone = phoneVal.valid ? phoneVal.normalized : '9876543210';


  const studentDoc = {
    uid: uid,
    name: name,
    usn: usn,
    phone: student.phone || '',
    email: email,
    dept: deptId,
    department: deptName || deptId,
    semester: sem,
    section: sec,
    parentName: parentName,
    parentPhone: parentPhone,
    smsEnabled: student.smsEnabled !== false,
    faceRegistered: false,
    createdAt: FieldValue.serverTimestamp(),
    approvedAt: FieldValue.serverTimestamp()
  };

  try {
    const batch = db.batch();
    batch.set(db.collection('uniqueEmails').doc(email), {
      email: email,
      uid: uid,
      role: 'student',
      createdAt: FieldValue.serverTimestamp()
    });
    batch.set(db.collection('uniqueUSNs').doc(usn), {
      usn: usn,
      uid: uid,
      role: 'student',
      createdAt: FieldValue.serverTimestamp()
    });
    batch.set(db.collection('students').doc(uid), studentDoc);
    await batch.commit();
  } catch (firestoreErr) {
    // Rollback created Firebase Auth account
    try {
      await admin.auth().deleteUser(uid);
      console.warn(`[Rollback] Deleted orphaned Auth user ${uid} after Firestore commit failure.`);
    } catch (rollbackErr) {
      console.error(`[Rollback Error] Failed to delete Auth user ${uid}:`, rollbackErr);
    }
    return { name, usn, email, status: 'failed', result: 'Student profile creation failed', reason: firestoreErr.message };
  }

  // 5. Auto-Enroll in matching subjects for Dept + Semester + Section
  try {
    const subjectsList = cachedSubjects || (await db.collection('subjects').get()).docs.map(d => ({ ref: d.ref, data: d.data() }));
    let enrollBatch = db.batch();
    let enrollCount = 0;

    for (const subItem of subjectsList) {
      const sub = subItem.data;
      const subDept = String(sub.departmentId || sub.department || '').trim().toLowerCase();
      const stuDeptId = String(deptId).trim().toLowerCase();
      const stuDeptName = String(deptName).trim().toLowerCase();
      const deptMatches = subDept === stuDeptId || subDept === stuDeptName;
      const semMatches = parseInt(sub.semester, 10) === sem;
      const secMatches = !sub.section || String(sub.section).trim().toUpperCase() === sec;

      if (deptMatches && semMatches && secMatches) {
        const roster = Array.isArray(sub.enrolledRoster) ? sub.enrolledRoster : [];
        const alreadyIn = roster.some(r => r && (r.id === uid || r.uid === uid));
        const updatedRoster = alreadyIn ? roster : [...roster, { id: uid, name: name, usn: usn }];
        enrollBatch.update(subItem.ref, {
          studentIds: FieldValue.arrayUnion(uid),
          enrolledRoster: updatedRoster
        });
        sub.enrolledRoster = updatedRoster;
        enrollCount++;
        if (enrollCount % 450 === 0) {
          await enrollBatch.commit();
          enrollBatch = db.batch();
        }
      }
    }

    if (enrollCount % 450 !== 0 && enrollCount > 0) {
      await enrollBatch.commit();
    }
  } catch (enrollErr) {
    console.warn(`[Auto-Enroll] Warning during subject enrollment for student ${uid}:`, enrollErr);
  }

  // 6. Trigger Password Setup Email
  let emailSent = false;
  let emailError = null;
  try {
    const emailResult = await triggerPasswordResetEmail(email);
    if (emailResult.ok) {
      emailSent = true;
    } else {
      emailError = emailResult.error;
    }
  } catch (emailEx) {
    emailError = emailEx.message;
  }

  if (emailSent) {
    return {
      name,
      usn,
      email,
      uid,
      status: 'success',
      result: 'Imported successfully',
      reason: null,
      emailSent: true
    };
  } else {
    return {
      name,
      usn,
      email,
      uid,
      status: 'partial_success',
      result: 'Student created, but password setup email could not be sent.',
      reason: emailError ? `Email error: ${emailError}` : 'Password setup email could not be dispatched',
      emailSent: false
    };
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cit-smart-attendance-backend', port: PORT }));
    return;
  }

  if (url.pathname === '/api/import-students' && req.method === 'POST') {
    try {
      // 1. Authenticate Request via Firebase ID Token
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();

      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authorization token required. Only authenticated administrators may import students.' }));
        return;
      }

      let decodedToken = null;
      try {
        decodedToken = await admin.auth().verifyIdToken(token);
      } catch (tokenErr) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired administrator token: ' + tokenErr.message }));
        return;
      }

      const isAuthorizedAdmin = await isAdminAuth(decodedToken);
      if (!isAuthorizedAdmin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden. Only authorized institutional administrators may import students.' }));
        return;
      }

      // 2. Parse Body
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }
      let body;
      try {
        body = JSON.parse(bodyStr || '{}');
      } catch (jsonErr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload: ' + jsonErr.message }));
        return;
      }
      const students = Array.isArray(body.students) ? body.students : [];

      if (!students.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No student records provided for import.' }));
        return;
      }

      // 3. Process Each Student Row Independently
      const departmentsMap = await loadDepartmentsMap();
      const subjectsSnap = await db.collection('subjects').get();
      const cachedSubjects = subjectsSnap.docs.map(doc => ({ ref: doc.ref, data: doc.data() }));
      const results = [];
      let importedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const stu of students) {
        const rowResult = await importSingleStudent(stu, departmentsMap, cachedSubjects);
        results.push(rowResult);
        if (rowResult.status === 'success' || rowResult.status === 'partial_success') {
          importedCount++;
        } else if (rowResult.status === 'skipped') {
          skippedCount++;
        } else {
          failedCount++;
        }
      }

      const summary = {
        total: students.length,
        imported: importedCount,
        failed: failedCount,
        skipped: skippedCount
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        summary,
        results
      }));
    } catch (err) {
      console.error('[Backend Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal server error during student import' }));
    }
    return;
  }

  if (url.pathname === '/api/finalize-attendance-sms' && req.method === 'POST') {
    try {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authorization token required.' }));
        return;
      }
      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(token);
      } catch (tokenErr) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired authorization token.' }));
        return;
      }
      let bodyStr = '';
      for await (const chunk of req) {
        bodyStr += chunk;
      }
      let body;
      try {
        body = JSON.parse(bodyStr || '{}');
      } catch (jsonErr) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload: ' + jsonErr.message }));
        return;
      }

      const { sessionId, subjectId, facultyUid } = body;
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sessionId is required to finalize attendance and dispatch absence SMS.' }));
        return;
      }

      if (!(await isAuthorizedToFinalize(decodedToken, sessionId))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only the assigned faculty member or an administrator may finalize this session.' }));
        return;
      }

      const result = await finalizeAttendanceSms({ sessionId, subjectId, facultyUid: decodedToken.uid || decodedToken.user_id });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[finalizeAttendanceSms Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Error finalizing attendance SMS' }));
    }
    return;
  }

  if (url.pathname === '/api/session-notifications' && req.method === 'GET') {
    try {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sessionId parameter is required.' }));
        return;
      }

      // Security check: verify Bearer token
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authorization token required.' }));
        return;
      }

      let decodedToken;
      try {
        decodedToken = await admin.auth().verifyIdToken(token);
      } catch (tokenErr) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired authorization token: ' + tokenErr.message }));
        return;
      }

      if (!(await isAuthorizedToFinalize(decodedToken, sessionId))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden. Only the assigned faculty member or an administrator may view session notification logs.' }));
        return;
      }

      const logsSnap = await db.collection('notificationLogs').where('sessionId', '==', sessionId).get();
      const logs = [];
      logsSnap.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: logs.length, logs }));
    } catch (err) {
      console.error('[sessionNotifications Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Error retrieving session notification logs' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`CIT Secure Backend Server running on http://localhost:${PORT}`);
  });
}

module.exports = {
  server,
  importSingleStudent,
  triggerPasswordResetEmail,
  isAdminAuth,
  isAuthorizedToFinalize,
  validateAndNormalizeIndianPhone,
  maskPhoneNumber,
  SmsService,
  smsService,
  finalizeAttendanceSms
};
