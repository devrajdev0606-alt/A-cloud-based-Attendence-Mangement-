const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const DELETE_BATCH_SIZE = 400;

function isAdmin(auth) {
  const email = String(auth?.token?.email || '').toLowerCase();
  return email === 'admin@cit.edu' || auth?.token?.admin === true;
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasReference(data, field, value) {
  return data && data[field] === value;
}

async function queryByFields(collectionName, queries) {
  const snapshots = await Promise.all(queries.map(({ field, operator = '==', value }) =>
    db.collection(collectionName).where(field, operator, value).get()));
  const documents = new Map();
  snapshots.forEach(snapshot => snapshot.forEach(doc => documents.set(doc.id, doc)));
  return Array.from(documents.values());
}

async function commitOperations(operations) {
  for (let index = 0; index < operations.length; index += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    operations.slice(index, index + DELETE_BATCH_SIZE).forEach(operation => {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else batch.update(operation.ref, operation.data);
    });
    await batch.commit();
  }
}

function removeFacultyFields() {
  return {
    facultyId: FieldValue.delete(),
    facultyUid: FieldValue.delete(),
    facultyName: FieldValue.delete()
  };
}

async function deleteStudent(uid) {
  const profileRef = db.collection('students').doc(uid);
  const profile = await profileRef.get();
  if (!profile.exists) return deleteAuthOnly(uid, 'student');

  const student = profile.data();
  const operations = [{ type: 'delete', ref: profileRef }];
  const [subjects, attendance, corrections, requests, emails] = await Promise.all([
    queryByFields('subjects', [{ field: 'studentIds', operator: 'array-contains', value: uid }]),
    queryByFields('attendance', [{ field: 'studentUid', value: uid }, { field: 'studentId', value: uid }]),
    queryByFields('attendanceCorrectionRequests', [{ field: 'studentUid', value: uid }, { field: 'studentId', value: uid }]),
    queryByFields('registrationRequests', [{ field: 'uid', value: uid }, { field: 'approvedAccountId', value: uid }]),
    queryByFields('uniqueEmails', [{ field: 'uid', value: uid }])
  ]);

  subjects.forEach(doc => {
    const data = doc.data();
    const ids = Array.isArray(data.studentIds) ? data.studentIds : [];
    const roster = Array.isArray(data.enrolledRoster) ? data.enrolledRoster : [];
    if (ids.includes(uid) || roster.some(item => item && (item.id === uid || item.uid === uid))) {
      operations.push({
        type: 'update',
        ref: doc.ref,
        data: {
          studentIds: ids.filter(id => id !== uid),
          enrolledRoster: roster.filter(item => item && item.id !== uid && item.uid !== uid)
        }
      });
    }
  });

  attendance.forEach(doc => {
    const data = doc.data();
    if (data.studentUid === uid || data.studentId === uid || doc.id.endsWith(`_${uid}`)) {
      operations.push({ type: 'delete', ref: doc.ref });
    }
  });

  corrections.forEach(doc => {
    const data = doc.data();
    if (data.studentUid === uid || data.studentId === uid) operations.push({ type: 'delete', ref: doc.ref });
  });

  requests.forEach(doc => {
    const data = doc.data();
    if (data.uid === uid || data.approvedAccountId === uid) operations.push({ type: 'delete', ref: doc.ref });
  });

  emails.forEach(doc => {
    if (doc.data().uid === uid || doc.id === String(student.email || '').toLowerCase()) {
      operations.push({ type: 'delete', ref: doc.ref });
    }
  });
  if (student.usn) operations.push({ type: 'delete', ref: db.collection('uniqueUSNs').doc(student.usn) });

  await commitOperations(operations);
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    throw new HttpsError('failed-precondition', 'Firestore data was deleted, but the Firebase Authentication account could not be deleted.', {
      uid,
      authError: error.code || 'unknown'
    });
  }
  return { deletedType: 'student', deletedId: uid, authDeleted: true };
}

async function deleteFaculty(uid) {
  const profileRef = db.collection('faculty').doc(uid);
  const profile = await profileRef.get();
  if (!profile.exists) return deleteAuthOnly(uid, 'faculty');

  const faculty = profile.data();
  const operations = [{ type: 'delete', ref: profileRef }];
  const [subjects, timetable, sessions, corrections, attendance, emails, requests] = await Promise.all([
    queryByFields('subjects', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('timetable', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('attendanceSessions', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('attendanceCorrectionRequests', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('attendance', [{ field: 'facultyId', value: uid }, { field: 'facultyUid', value: uid }]),
    queryByFields('uniqueEmails', [{ field: 'uid', value: uid }]),
    queryByFields('registrationRequests', [{ field: 'uid', value: uid }, { field: 'approvedAccountId', value: uid }])
  ]);

  subjects.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  timetable.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  sessions.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  corrections.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  attendance.forEach(doc => {
    const data = doc.data();
    if (hasReference(data, 'facultyId', uid) || hasReference(data, 'facultyUid', uid)) {
      operations.push({ type: 'update', ref: doc.ref, data: removeFacultyFields() });
    }
  });
  emails.forEach(doc => {
    if (doc.data().uid === uid || doc.id === String(faculty.email || '').toLowerCase()) operations.push({ type: 'delete', ref: doc.ref });
  });
  requests.forEach(doc => {
    const data = doc.data();
    if (data.uid === uid || data.approvedAccountId === uid) operations.push({ type: 'delete', ref: doc.ref });
  });

  await commitOperations(operations);
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    throw new HttpsError('failed-precondition', 'Firestore data was deleted, but the Firebase Authentication account could not be deleted.', {
      uid,
      authError: error.code || 'unknown'
    });
  }
  return { deletedType: 'faculty', deletedId: uid, authDeleted: true };
}

async function deleteAuthOnly(uid, type) {
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return { deletedType: type, deletedId: uid, authDeleted: true };
    }
    throw new HttpsError('failed-precondition', 'The profile is already gone, but the Firebase Authentication account could not be deleted.', {
      uid,
      authError: error.code || 'unknown'
    });
  }
  return { deletedType: type, deletedId: uid, authDeleted: true };
}

async function deleteSubject(subjectId) {
  const subjectRef = db.collection('subjects').doc(subjectId);
  const subject = await subjectRef.get();
  if (!subject.exists) throw new HttpsError('not-found', 'Subject was not found.');
  const data = subject.data();
  const operations = [
    { type: 'delete', ref: subjectRef }
  ];
  const [timetable, sessions, attendance, corrections] = await Promise.all([
    queryByFields('timetable', [{ field: 'subjectId', value: subjectId }]),
    queryByFields('attendanceSessions', [{ field: 'subjectId', value: subjectId }]),
    queryByFields('attendance', [{ field: 'subjectId', value: subjectId }]),
    queryByFields('attendanceCorrectionRequests', [{ field: 'subjectId', value: subjectId }])
  ]);
  [timetable, sessions, attendance, corrections].forEach(docs => docs.forEach(doc => {
    if (doc.data().subjectId === subjectId) operations.push({ type: 'delete', ref: doc.ref });
  }));
  if (data.normalizedCode) operations.push({ type: 'delete', ref: db.collection('uniqueSubjectCodes').doc(data.normalizedCode) });
  if (data.offeringKey) operations.push({ type: 'delete', ref: db.collection('uniqueOfferings').doc(data.offeringKey) });
  await commitOperations(operations);
  return { deletedType: 'subject', deletedId: subjectId, authDeleted: false };
}

async function deleteDepartment(departmentId) {
  const departmentRef = db.collection('departments').doc(departmentId);
  const department = await departmentRef.get();
  if (!department.exists) throw new HttpsError('not-found', 'Department was not found.');
  const [students, faculty, subjects, timetable] = await Promise.all([
    queryByFields('students', [{ field: 'dept', value: departmentId }, { field: 'department', value: departmentId }]),
    queryByFields('faculty', [{ field: 'department', value: departmentId }]),
    queryByFields('subjects', [{ field: 'departmentId', value: departmentId }, { field: 'department', value: departmentId }]),
    queryByFields('timetable', [{ field: 'departmentId', value: departmentId }, { field: 'department', value: departmentId }])
  ]);
  const hasChildren = students.some(doc => [doc.data().dept, doc.data().department].includes(departmentId)) ||
    faculty.some(doc => doc.data().department === departmentId) ||
    subjects.some(doc => [doc.data().departmentId, doc.data().department].includes(departmentId)) ||
    timetable.some(doc => [doc.data().departmentId, doc.data().department].includes(departmentId));
  if (hasChildren) throw new HttpsError('failed-precondition', 'Department still has dependent records. Delete or reassign those records first.');
  await departmentRef.delete();
  return { deletedType: 'department', deletedId: departmentId, authDeleted: false };
}

async function deleteEntity(type, id) {
  if (!asString(id)) throw new HttpsError('invalid-argument', 'A target document ID is required.');
  if (type === 'student') return deleteStudent(id);
  if (type === 'faculty') return deleteFaculty(id);
  if (type === 'subject') return deleteSubject(id);
  if (type === 'department') return deleteDepartment(id);
  if (type === 'timetable' || type === 'settings') {
    const collection = type === 'timetable' ? 'timetable' : 'settings';
    const ref = db.collection(collection).doc(id);
    if (!(await ref.get()).exists) throw new HttpsError('not-found', `${type} record was not found.`);
    await ref.delete();
    return { deletedType: type, deletedId: id, authDeleted: false };
  }
  throw new HttpsError('invalid-argument', `Unsupported deletion type: ${type}`);
}

exports.deleteAdminEntity = onCall(async request => {
  if (!request.auth || !isAdmin(request.auth)) {
    throw new HttpsError('permission-denied', 'Only an authenticated Admin may permanently delete records.');
  }
  const type = asString(request.data?.type);
  const id = asString(request.data?.id);
  return deleteEntity(type, id);
});
