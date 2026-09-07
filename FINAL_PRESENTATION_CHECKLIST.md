# CIT Smart Attendance Presentation Checklist

Use this checklist during the final manual rehearsal. Mark an item only after testing it in the browser.

## Admin
- [ ] Login
- [ ] Dashboard
- [ ] Department
- [ ] Student
- [ ] Faculty
- [ ] Subject
- [ ] Timetable
- [ ] Reports

## Faculty
- [ ] Login
- [ ] Today's classes
- [ ] Assigned subjects
- [ ] Start attendance
- [ ] Stop attendance
- [ ] Live attendance
- [ ] Present count
- [ ] Analytics
- [ ] Correction requests

## Student
- [ ] Login
- [ ] Today's classes
- [ ] Active class
- [ ] Camera
- [ ] Face verification
- [ ] GPS verification
- [ ] Mark attendance
- [ ] Duplicate prevention
- [ ] Attendance history
- [ ] Attendance percentage
- [ ] Correction request

## Security
- [ ] Unauthorized access
- [ ] Duplicate attendance
- [ ] Wrong student
- [ ] Wrong subject
- [ ] Inactive session
- [ ] Faculty ownership
- [ ] Biometric privacy

## Performance
- [ ] No unnecessary Firestore reads
- [ ] No repeated model loading
- [ ] No camera leak
- [ ] No GPS watcher leak
- [ ] No timer leak
- [ ] No duplicate listeners
- [ ] No application console errors

## Presentation Smoke Flow
- [ ] Admin configures attendance location in `settings/attendance`
- [ ] Faculty starts a session using the configured classroom location
- [ ] Student sees the active subject and session
- [ ] Student completes face and GPS verification
- [ ] Attendance uses `${sessionId}_${studentUid}`
- [ ] Faculty sees the student as present
- [ ] Student refresh restores the marked state
- [ ] Duplicate attempt is blocked
- [ ] Faculty stops the session
- [ ] A new session creates a new attendance key
