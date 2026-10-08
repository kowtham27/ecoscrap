# EcoScrap AI – Smart E-Waste Collection & Recycling Platform

♻️ A comprehensive web platform connecting informal scrap dealers (Kabadiwalas) and households to government-authorized CPCB e-waste recyclers in India.

## 🌟 Features

- **3-Role Secure Login Dashboard** – Customer, Kabadiwala (Scrap Dealer), Authorized Recycler
- **Live 10-Second Scrap Commodity Ticker** – Real-time price fluctuation with SVG charts
- **100g+ Micro-Weight Cash Calculator** – Instant doorstep pricing from just 100 grams
- **Google Maps Integration** – Live facility locations & dealer tracking with ETA
- **7 Indian Languages** – English, Hindi, Marathi, Tamil, Telugu, Kannada, Malayalam + Voice TTS
- **CPCB Form-6 EPR Compliance** – Digital recycling certificates with QR codes
- **Anti-Snoop Marketplace** – Wholesale rates hidden from public; role-based access control

## 🚀 How to Run

This is now a real full-stack app: a Node/Express backend backed by a persistent SQLite database (via Node's built-in `node:sqlite`), serving the existing frontend.

```
npm install
npm start
# Then visit http://localhost:3000
```

To turn on the AI Scrap Scanner, copy `.env.example` to `.env` and set `GEMINI_API_KEY`
(free key from https://aistudio.google.com/apikey), then restart the server. The camera opens
in-page on `localhost` or any `https://` address; on a phone opening the app over plain
`http://` on your LAN, the button opens the phone's own camera app instead.

Data (materials & rates, registered kabadiwalas/recyclers, lots/transactions, safety guides) lives in `data/esetu.db` and survives server restarts. The database is seeded once from `server/seed-data.js` the first time it's created.

## 🔑 Demo Access

No fake accounts are pre-seeded — dealers and recyclers only exist once someone registers
through the app, so there is no fixed demo PIN to share.

| Role | How to access |
|------|-----------|
| Customer | Any name & phone — no registration needed |
| Kabadiwala (Scrap Dealer) | Use "New Dealer Registration" (auto-assigns a PIN of `1234`), or sign in with a phone/PIN from a dealer already registered on this instance |
| Recycler | Enter any CPCB/SPCB-format registration number (e.g. `CPCB/EPR-REC/2023/MH-0842`) — first use registers it for real; entering it again signs back in |

## ✨ Innovation Features (built to match the pitch deck)

All 28 features pitched across the 8 innovation categories are real and working — not
static mocks. Notably:
- **AI Scrap Scanner & Quality Checker** — in-page camera capture, then Google Gemini identifies the item, maps it to one of the platform's materials and grades its condition (`js/scrap-scanner.js`, `server/gemini-scan.js`). Needs `GEMINI_API_KEY` in `.env` and internet; without it the customer picks the material by hand
- **Fair Price Detector / Fraud-Free Payments** — flags offers that drift from the benchmark rate
- **Smart Weighing** — an honestly-labeled Bluetooth-scale *simulation* (no real hardware exists to integrate)
- **Digital Scrap Passport & Verified Handover** — real GPS + photo captured at pickup, persisted per booking
- **Voice Selling & AI Voice Assistant** — Web Speech API input/output, answers composed from live platform data
- **Offline Mode** — cached price snapshot + a real queued-write sync for bookings
- **Smart Recycler Matching / Best Buyer Finder / Recycler Verification** — real distance sorting, per-recycler rate publishing, and a local CPCB registration-format mirror (not a live government API — none is publicly available)
- **Collection Route Optimizer & E-Waste Hotspot Map** — nearest-neighbor routing and a real Leaflet/OpenStreetMap view (map tiles need internet even though the rest of the app works offline)
- **Community & Institutions / Fair Rotation Contracts** — institutional bulk-collection accounts and renewable dealer contracts
- **Better Earnings (load pooling)** and a live-computed **Environmental Tracker** (CO₂/trees, from real completed transaction weights)

## 📁 Project Structure

```
EcoScrap AI/
├── index.html          # Main entry point
├── css/style.css       # Full responsive stylesheet
├── js/
│   ├── api.js           # Fetch client for the backend REST API
│   ├── app.js            # Application controller & all views
│   └── i18n.js           # 7-language translation engine
├── server/
│   ├── server.js         # Express app: serves the API + the static frontend
│   ├── api.js             # REST API routes (/api/*)
│   ├── db.js               # SQLite schema + one-time seed (node:sqlite)
│   └── seed-data.js        # Initial data used to seed the database
├── data/esetu.db        # Persistent SQLite database (created on first run)
└── docs/
    ├── unit_economics.md
    ├── field_research.md
    └── datasets_schema.md
```

## 👥 Team

Built for Smart India Hackathon / E-Waste Innovation Challenge.

## 📜 License

MIT License
