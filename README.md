# RideShare

RideShare is a campus-focused ride-sharing application for Thapar students. Students can create trips, discover available rides, join groups, and connect with other students travelling along similar routes. Rides show which members you already know (1st, 2nd or 3rd-degree connections) and the driver and car details.

## Live Demo

| Part | URL |
|---|---|
| Web app | https://rideshare-app-virid.vercel.app |
| Backend API | https://rideshare-backend-kohl.vercel.app |

Both are deployed on Vercel from the `main` branch. Every push to `main` redeploys them. The database is PostgreSQL hosted on Neon.

The demo database is seeded with 40 **fictional** students (roll numbers `102900001`–`102900040`) and about 30 upcoming rides. Any of them can be used to try the app. For example, email `asharma_be26@thapar.edu`, password `Thapar@2026`.

## Features

- **Student Authentication:** Register and log in with a `@thapar.edu` email. Every field is validated on both the app and the server, errors are shown clearly on the form, wrong logins are rate-limited, and sessions renew automatically.
- **Create Rides:** Add start, destination, intermediate stops, departure time, seat capacity, preference (All / Female only), and optional driver name, phone number, car model and car number. Either the start or the destination must be Patiala.
- **Find Rides:** Search by route (city names are case-insensitive) and departure time, or tap **Show all rides** to list every upcoming ride regardless of filters.
- **Manage Groups:** Join or leave ride groups and view the route, departure time, driver and car, members, and available seats.
- **Connection Requests:** Tap **Connect** on a fellow rider to send a request. The connection forms only when they **Accept**. Pending requests appear under Profile → Connections.
- **Degrees of Connection:** Every member you're linked to is labelled **1st** (your connection), **2nd** (connection of a connection, e.g. "Connection of Aarav Sharma"), or **3rd** (e.g. "via Aarav Sharma → Arjun Mehta").
- **Smart Ranking:** Search results are ordered by mutual connections, then by available seats.
- **Female-only rides:** Only female students can create them, and they are hidden from male students.

## Tech Stack

| Component | Technologies |
|---|---|
| Mobile / Web App | React Native, Expo (web export), React Navigation |
| Backend | Node.js, Express.js |
| Database | PostgreSQL (Neon in production) |
| Authentication | JWT access + refresh tokens, bcrypt, express-rate-limit |
| Recommendation Engine (standalone) | Python, Flask, Pandas, NumPy |

## Project Structure

```text
RideShare/
├── backend/
│   ├── server.js          # Express API
│   ├── schema.sql         # Database schema
│   ├── .env.example       # Backend environment template
│   ├── algo.py            # Standalone recommendation experiments
│   ├── algo_service.py
│   ├── cities/            # Valid city list
│   └── package.json
├── mobile/
│   ├── App.js             # Navigation + automatic session renewal
│   ├── .env.example       # App environment template
│   ├── vercel.json        # Web deployment config
│   ├── screens/
│   │   ├── LoginScreen.js
│   │   ├── GroupsScreen.js
│   │   ├── CreateTripScreen.js
│   │   ├── GroupDetailsScreen.js
│   │   └── ProfileScreen.js
│   └── components/
└── documents/
```

## Running It Locally

You need two terminals: one for the backend and one for the app.

### Prerequisites

- [Node.js 18+](https://nodejs.org) (check with `node -v`)
- [Git](https://git-scm.com)
- A PostgreSQL database. Either:
  - **Easiest:** a free [Neon](https://neon.tech) database. Copy its connection string.
  - **Or** PostgreSQL installed on your computer.
- To use a phone, install the **Expo Go** app. For the browser version, you need nothing extra.

### 1. Clone the repository

```bash
git clone https://github.com/Avani19051/RideShare.git
cd RideShare
```

### 2. Set up the database

Run `backend/schema.sql` once on your database:

- **Neon:** open the SQL Editor, paste the contents of `backend/schema.sql`, and click Run.
- **Local PostgreSQL:**

  ```bash
  createdb rideshare
  psql -d rideshare -f backend/schema.sql
  ```

The backend also adds any newer columns automatically when it starts.

### 3. Start the backend (terminal 1)

```bash
cd backend
npm install
```

Copy `backend/.env.example` to `backend/.env` and fill it in:

```env
PORT=3000
# Neon / hosted Postgres (SSL is used automatically):
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
# Local Postgres without SSL:
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rideshare?sslmode=disable
JWT_SECRET=any-long-random-string
```

Then run:

```bash
npm run dev
```

You should see `RideShare backend listening on http://localhost:3000`. To check it, open http://localhost:3000. It should say `"RideShare backend OK"`.

### 4. Start the app (terminal 2)

```bash
cd mobile
npm install
```

Copy `mobile/.env.example` to `mobile/.env` and set where the backend is:

```env
# Browser on the same computer:
EXPO_PUBLIC_BACKEND_BASE=http://localhost:3000
# Phone with Expo Go: use your computer's Wi-Fi IP instead (same Wi-Fi network)
# EXPO_PUBLIC_BACKEND_BASE=http://192.168.1.23:3000
# Or skip running the backend locally and use the live one:
# EXPO_PUBLIC_BACKEND_BASE=https://rideshare-backend-kohl.vercel.app
```

Then start Expo:

```bash
npx expo start
```

- Press **`w`** to open it in your browser.
- Or scan the QR code with **Expo Go** on your phone.

> To find your computer's IP: run `ipconfig` on Windows (look for "IPv4 Address") or `ipconfig getifaddr en0` on macOS.
> After changing `.env`, stop Expo (Ctrl+C) and run `npx expo start -c` so it picks up the new value.

### 5. Recommendation service (optional, standalone)

The app does not need this. It's a separate Flask experiment:

```bash
cd backend
pip install -r requirements.txt
python algo_service.py
```

It runs on port 5000.

### Troubleshooting

| Problem | Fix |
|---|---|
| `Can't reach the server` on the login screen | The backend isn't running, or `EXPO_PUBLIC_BACKEND_BASE` is wrong. On a phone, `localhost` won't work, so use your computer's IP. |
| Backend crashes with `relation "users" does not exist` | Run `backend/schema.sql` on the database (step 2). |
| Backend can't connect to local Postgres (SSL error) | Add `?sslmode=disable` to the end of `DATABASE_URL`. |
| Searches find nothing | Rides are only listed if Patiala is the start or the destination. Try **Show all rides**. |

## Authentication

- **Registration rules:**
  - Name: 2–60 letters.
  - Roll number: 6–12 digits.
  - Email: `@thapar.edu` only.
  - Password: 8–72 characters, with at least one letter and one number.
  - Gender: M or F.
  - Year: 1–5.
  - Each email and each roll number can only be registered once.
- **Login:** a wrong email and a wrong password get the same reply ("Incorrect email or password"), so nobody can find out which emails are registered. After 10 failed attempts for the same email from the same IP, login is blocked for 15 minutes.
- **Sessions:** an access token lasts 15 minutes and a refresh token lasts 30 days. The app renews the access token automatically, and refresh tokens are rejected if used as access tokens. Logging out revokes the refresh token.

## API Overview

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/register` | – | Register a student (returns a session) |
| POST | `/login` | – | Log in |
| POST | `/token/refresh` | – | Exchange a refresh token for a new access token |
| POST | `/logout` | – | Revoke a refresh token |
| POST | `/create-trip` | ✔ | Create a ride (with optional `driver_name`, `driver_phone`, `car_model`, `car_number`) |
| POST | `/search-groups` | optional | Find rides. Send `{}` to list all rides. With a token, results include connection degrees. |
| GET | `/groups/:gid` | ✔ | Ride details, including each member's degree and who links you |
| POST | `/join-group` | ✔ | Join a ride group |
| POST | `/leave-group` | ✔ | Leave a ride group |
| GET | `/my-rides` | ✔ | Rides you created or joined |
| POST | `/connections` | ✔ | Send a connection request (`other_uid`) |
| POST | `/connections/respond` | ✔ | Accept or decline a request (`from_uid`, `action`) |
| GET | `/connections/me` | ✔ | Your connections plus incoming and outgoing requests |
| GET | `/connections/suggested` | ✔ | Friends-of-friends suggestions |

Protected endpoints need the header `Authorization: Bearer <accessToken>`.

## Deployment

- **Backend:** Vercel project with root directory `backend` and the Express preset. Environment variables: `DATABASE_URL`, `JWT_SECRET`.
- **Web app:** Vercel project with root directory `mobile`. `vercel.json` builds it with `expo export -p web`. Environment variable: `EXPO_PUBLIC_BACKEND_BASE` (the backend URL).

## License

No license is currently specified for this repository.
