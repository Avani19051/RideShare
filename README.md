# RideShare

RideShare is a campus-focused ride-sharing application that helps students find and coordinate shared rides. Students can create trips, discover available rides, join groups, and connect with other students travelling along similar routes.

## Features

- **Student Authentication:** Register and log in using a Thapar email address.
- **Create Rides:** Add pickup locations, destinations, intermediate stops, departure times, seat capacity, and ride preferences.
- **Find Rides:** Search for available rides based on routes and departure times.
- **Manage Groups:** Join or leave ride groups and view routes, members, and available seats.
- **Student Connections:** Connect with other students and discover mutual connections.
- **Smart Recommendations:** Rank ride groups based on route compatibility, available seats, preferences, departure-time proximity, and student connections.

## Tech Stack

| Component | Technologies |
|---|---|
| Mobile App | React Native, Expo, React Navigation |
| Backend | Node.js, Express.js |
| Database | PostgreSQL |
| Authentication | JWT, bcrypt |
| Recommendation Engine | Python, Flask, Pandas, NumPy |

## Project Structure

```text
RideShare/
├── backend/
│   ├── server.js
│   ├── schema.sql
│   ├── algo.py
│   ├── algo_service.py
│   ├── cities/
│   └── package.json
├── mobile/
│   ├── App.js
│   ├── screens/
│   │   ├── LoginScreen.js
│   │   ├── GroupsScreen.js
│   │   ├── CreateTripScreen.js
│   │   ├── GroupDetailsScreen.js
│   │   └── ProfileScreen.js
│   └── components/
└── documents/
```

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL
- Python 3.9+ (for the recommendation service)
- Expo Go

### 1. Clone the Repository

```bash
git clone https://github.com/Avani19051/RideShare.git
cd RideShare
```

### 2. Set Up the Database

Create a PostgreSQL database and run the schema:

```bash
createdb rideshare
psql -d rideshare -f backend/schema.sql
```

### 3. Start the Backend

Configure the environment variables in `backend/.env`:

```env
PORT=3000
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
JWT_SECRET=your_secret_key
```

Install dependencies and start the server:

```bash
cd backend
npm install
npm run dev
```

### 4. Start the Mobile App

In a separate terminal:

```bash
cd mobile
npm install
npx expo start
```

Configure the backend URL in `mobile/.env`:

```env
EXPO_PUBLIC_BACKEND_BASE=http://YOUR_LOCAL_IP:3000
```

Open the application using Expo Go or an emulator.

### 5. Run the Recommendation Service (Optional)

```bash
cd backend
pip install -r requirements.txt
python algo_service.py
```

The Flask service runs on port 5000 by default.

## API Overview

| Method | Endpoint | Description |
|---|---|---|
| POST | `/register` | Register a student |
| POST | `/login` | Authenticate a student |
| POST | `/create-trip` | Create a ride |
| POST | `/search-groups` | Find available rides |
| GET | `/groups/:gid` | View ride details |
| POST | `/join-group` | Join a ride group |
| POST | `/leave-group` | Leave a ride group |
| GET | `/my-rides` | View personal rides |
| POST | `/connections` | Connect with students |
| GET | `/connections/me` | View connections |

Protected endpoints require JWT-based authentication.

## Key Highlights

- Campus-specific ride-sharing with student email authentication.
- Route and time-based ride discovery.
- Group management and student connectivity.
- Recommendation logic combining route compatibility and social connections.
- Separate Node.js backend and Python recommendation service.

## License

No license is currently specified for this repository.
