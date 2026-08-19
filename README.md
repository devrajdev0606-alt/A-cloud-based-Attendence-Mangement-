# 🎓 Smart Attendance Management System

A web-based attendance management system that uses **facial recognition** and **GPS location verification** to ensure secure and accurate attendance tracking. Designed for educational institutions to modernize attendance management with biometric verification.

---

## 📋 Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Setup & Installation](#setup--installation)
- [Usage Guide](#usage-guide)
  - [Admin Workflow](#admin-workflow)
  - [Faculty Workflow](#faculty-workflow)
  - [Student Workflow](#student-workflow)
- [Firebase Configuration](#firebase-configuration)
- [Security Rules](#security-rules)
- [Demo Credentials](#demo-credentials)
- [Limitations & Notes](#limitations--notes)
- [Future Improvements](#future-improvements)

---

## ✨ Features

### 🔐 Dual Verification System
- **Face Recognition**: Uses face-api.js (TinyFaceDetector) for biometric identity verification (85%+ match threshold)
- **GPS Location**: Verifies student is within configurable distance (default 10m) of the faculty's location
- **Duplicate Prevention**: Blocks multiple attendance entries for the same session

### 👨‍💼 Admin Panel (`admin.html`)
- **Department Management**: Create and manage departments
- **Student Management**: Add/edit/delete students with email and password authentication
- **Faculty Management**: Add/edit/delete faculty members
- **Subject Management**: Create subjects with codes and assign faculty
- **Student Assignment**: Assign students to specific subjects
- **Quick Stats Dashboard**: Real-time overview of students, faculty, subjects, and departments
- **Configurable Settings**: Adjust GPS distance threshold for attendance verification
- **Department-wise Listings**: View students, faculty, and subjects filtered by department

### 👩‍🏫 Faculty Dashboard (`faculty_dashboard.html`)
- **Subject Overview**: View all assigned subjects with enrolled student counts
- **Attendance Session Control**: Start and stop attendance sessions for any subject
- **GPS Location Capture**: Automatically captures faculty location when starting a session
- **Session Management**: Multi-session support with auto-incrementing class numbers
- **Attendance Analytics**: Visual attendance matrix showing present/absent for each class
- **Export Reports**: Download attendance reports as CSV

### 👨‍🎓 Student Portal (`dashboard.html`)
- **My Subjects**: View enrolled subjects
- **Active Session Alerts**: Real-time notifications of active attendance sessions
- **Face Registration**: One-time face registration with camera capture
- **Mark Attendance**: Capture face + GPS to mark attendance
- **Attendance History**: View complete attendance records with distance and location details
- **Session Filtering**: Select specific subjects to mark attendance

### 📊 Reports
- **Admin Report** (`report.html`): Complete attendance overview for all students with filtering by date, subject, and faculty
- **Faculty Report** (`faculty_report.html`): Subject-specific attendance reports with export capability

---

## ⚙️ How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Admin Panel   │────▶│  Firebase       │────▶│   Faculty       │
│                 │     │  Firestore      │     │   Dashboard     │
│ - Add Users     │     │  Database       │     │                 │
│ - Create        │     │  - Students     │     │ - Start Session │
│   Subjects      │     │  - Faculty      │     │ - GPS Location  │
│ - Assign        │     │  - Subjects     │     │ - View Reports  │
│   Students      │     │  - Attendance   │     │                 │
└─────────────────┘     │  - Sessions     │     └─────────────────┘
                        └─────────────────┘              │
                                                       │
                              ┌────────────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │   Student       │
                       │                 │
                       │ - Register Face │
                       │ - View Sessions │
                       │ - Mark Attendance│
                       │   (Face + GPS)  │
                       └─────────────────┘
```

### Attendance Flow:
1. **Faculty** starts an attendance session → System captures GPS location
2. **Student** sees active session notification
3. **Student** opens camera → Face is detected and compared with registered face (85% threshold)
4. **Student's GPS** is captured and distance from faculty is calculated using Haversine formula
5. If **face matches** AND **within 10m radius** → Attendance is recorded in Firebase
6. **Admin/Faculty** can view and export reports

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| **Frontend** | Pure HTML5, CSS3, JavaScript (Vanilla) |
| **Database** | Firebase Firestore (NoSQL Cloud Database) |
| **Face Recognition** | face-api.js v0.22.1 (TinyFaceDetector model) |
| **Location** | HTML5 Geolocation API |
| **Hosting** | Firebase Hosting |

---

## 📁 Project Structure

```
attendance-management-system-demo/
├── index.html              # Home page - Role selection (Admin/Faculty/Student)
├── admin.html              # Admin dashboard - Manage users, subjects, settings
├── faculty.html            # Faculty login page
├── faculty_dashboard.html  # Faculty control panel - Start sessions, analytics
├── faculty_report.html     # Faculty attendance report with CSV export
├── student.html            # Student login page
├── dashboard.html          # Student portal - Face reg, mark attendance, history
├── report.html             # Admin attendance report with filters
├── SETUP.md                # Detailed setup instructions
├── firebase.json           # Firebase hosting configuration
├── firestore.rules         # Firestore security rules
├── .gitignore              # Git ignore configurations
├── .env                    # Environment variables (not tracked)
└── README.md               # This file
```

---

## 📋 Prerequisites

- A modern web browser (Chrome, Firefox, Edge, Safari)
- Internet connection (for loading face-api.js models from CDN)
- HTTPS or localhost (required for GPS and Camera APIs)
- A Firebase account (free tier works for demo)

---

## 🚀 Setup & Installation

### Step 1: Clone the Repository
```bash
git clone https://github.com/NishanthM1/attendance-management-system-demo.git
cd attendance-management-system-demo
```

### Step 2: Firebase Setup
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or use existing one
3. Enable **Firestore Database** in "Build" section
4. Copy your Firebase configuration

### Step 3: Update Firebase Config
Update the shared `firebase-config.js` file once with your project credentials.

### Step 4: Configure Firestore Security Rules
Deploy the checked-in rules with:
```bash
firebase deploy --only firestore:rules
```
The current rules support the legacy demo login flow and are permissive. Add Firebase Authentication and role-based rules before using real personal or biometric data.

### Step 5: Run the Application
```bash
# Option 1: Using Python
python -m http.server 8080

# Option 2: Using Node.js
npx serve .

# Option 3: Using VS Code Live Server extension
# Right-click index.html → "Open with Live Server"
```

Open `http://localhost:8080` in your browser.

---

## 📖 Usage Guide

### Admin Workflow

1. **Login as Admin**
   - Open `index.html` → Click **"👨‍💼 Admin"**
   - No authentication required for demo (would need proper auth in production)

2. **Create Department**
   - Enter department name (e.g., "Computer Science")
   - Click "Add Department"

3. **Add Faculty**
   - Fill in name, email, password
   - Select department
   - Click "Add Faculty"

4. **Add Student**
   - Fill in name, email, password
   - Select department
   - Click "Add Student"

5. **Create Subject**
   - Enter subject name and code
   - Select faculty and department
   - Click "Create Subject"

6. **Assign Students to Subject**
   - Select a subject from dropdown
   - Check students to assign
   - Click "Assign Students"

7. **Configure Settings**
   - Set GPS distance threshold (meters)
   - Default is 10 meters

8. **View Reports**
   - Click "📊 View Attendance Report" to see all attendance records
   - Filter by date, subject, or faculty
   - Export as CSV

### Faculty Workflow

1. **Login**
   - Open `faculty.html`
   - Enter email and password
   - Click "Login"

2. **View Subjects**
   - See all assigned subjects with student counts

3. **Start Attendance Session**
   - Click "Start Attendance" for a subject
   - Select duration (5/10/15 minutes)
   - System captures your GPS location

4. **Monitor Active Sessions**
   - See all active sessions with location details
   - View attendance by clicking "View Attendance"

5. **View Analytics**
   - Go to "Subject Attendance Analytics"
   - Select a subject
   - See attendance matrix (P/A for each class)

6. **Export Reports**
   - Go to Attendance Report
   - Filter by date
   - Export as CSV

### Student Workflow

1. **Login**
   - Open `student.html`
   - Enter email and password

2. **Register Face (First Time)**
   - Go to "Register Face" section
   - Click "Open Camera"
   - Position face in frame
   - Click "Capture & Register Face"

3. **Mark Attendance**
   - Select subject from dropdown
   - Click "Open Camera"
   - Position face in frame
   - Click "Mark Attendance"
   - System verifies face + GPS automatically

4. **View Attendance History**
   - See all past attendance records
   - View date, subject, time, distance, and location

---

## 🔥 Firebase Configuration

The project uses the following Firebase collections:

| Collection | Description |
|-----------|-------------|
| `departments` | Department records (id, name, createdAt) |
| `students` | Student records (id, name, email, password, dept, faceDescriptor, faceRegistered) |
| `faculty` | Faculty records (id, name, email, password, department, createdAt) |
| `subjects` | Subject records (id, subjectName, subjectCode, facultyId, departmentId, studentIds[]) |
| `attendanceSessions` | Active/past attendance sessions (id, subjectId, facultyId, active, latitude, longitude, duration, classNumber) |
| `attendance` | Attendance records (id, studentId, subjectId, sessionId, date, time, latitude, longitude, distance) |
| `settings` | System settings (distanceThreshold) |

---

## 🔒 Security Rules

**⚠️ Important:** The current security rules are set to `allow read, write: if true` for demo purposes. This is **NOT secure for production**.

For production, implement proper authentication:
- Use Firebase Authentication (Email/Password)
- Replace plain-text password storage with Firebase Auth
- Update security rules to check `request.auth.uid`

---

## 🎯 Demo Credentials

Use these credentials to test the complete flow:

| Role | Email | Password |
|------|-------|----------|
| **Faculty** | kumar@gmail.com | 123456 |
| **Student** | nishanth@gmail.com | 123456 |

---

## ⚠️ Limitations & Notes

1. **No Authentication**: No Firebase Auth in this demo. Passwords stored in plain text (acceptable for MCA/demo projects).
2. **Test Mode Security**: Firestore rules allow all reads/writes. Change for production.
3. **Face Models**: Loaded from CDN (jsdelivr). Requires internet connection.
4. **GPS Requirements**: GPS works only on HTTPS or localhost.
5. **Browser Support**: Best on Chrome/Edge. Safari may have limitations.
6. **Camera Permission**: Requires explicit camera access from user.
7. **Offline Mode**: Not supported. Requires internet for Firebase operations.

---

## 🔮 Future Improvements

- [ ] Implement Firebase Authentication for secure login
- [ ] Hash passwords instead of plain text
- [ ] Add attendance percentage calculation with warning thresholds
- [ ] Email/SMS notifications for low attendance
- [ ] QR code-based attendance as alternative option
- [ ] Mobile app version (React Native/Flutter)
- [ ] Attendance calendar view
- [ ] Bulk import students via CSV
- [ ] Face recognition timeout with liveness detection
- [ ] Offline mode with sync on reconnection

---

## 📄 License

This project is developed as a demo for educational purposes (MCA/BCA final year project).

---

## 👨‍💻 Developer

Built with ❤️ using HTML, CSS, JavaScript, and Firebase

**GitHub**: [@NishanthM1](https://github.com/NishanthM1)

---

## 🙏 Acknowledgments

- [face-api.js](https://github.com/justadudewhohacks/face-api.js) - Face recognition library
- [Firebase](https://firebase.google.com/) - Backend and hosting
- Font Awesome for icons

---

## 📞 Support

For issues or questions, please open an issue on GitHub.
