# Delhi Public School, Amrapali Yojna - Stationery Inventory App (DPSIMS)

Official Stationery & Inventory Management Application for Delhi Public School (DPSIMS).

## Features

- **Store Inventory & Ledger:** 84 items across paper, registers, adhesives, writing, and office supplies with 149 variants and real-time stock balances.
- **Progressive Web App (PWA):** Installable on desktop, mobile, and tablets; runs 100% offline via Service Worker (`sw.js`).
- **Standard Requisition Slip Printing:** Compact A4 printing (2–3 slips/page) with cutting guides and teacher signature blocks.
- **Scannable QR Codes with Official DPS Crest:** High error-correction (Level H - 30%) QR codes on every slip that phone cameras and 2D barcode scanners can read instantly to open or verify slips.
- **In-App Camera & Barcode Scanner:** Interactive slip lookup with live webcam scanner via `BarcodeDetector` and support for USB/Bluetooth handheld barcode guns.
- **Multi-Role Authentication:** Dedicated sign-in portals for Admin, Principal, and 13 registered faculty members with PIN and password authentication.
- **Local Network Host:** Self-contained lightweight Node.js server with live data persistence (`/api/data` in `data.json`).

## Quick Start

### 1. Launch Server
Double-click `start-server.bat` or run:
```bash
node server.js
```

### 2. Access App
- **This Computer:** [http://localhost:3000/](http://localhost:3000/)
- **Network Devices (Phones/Tablets on same Wi-Fi):** `http://<your-local-ip>:3000/`

## Technology Stack
- HTML5 / Vanilla JavaScript / Modern CSS
- QR Code Engine (Model 2, Error Correction Level H)
- Service Worker & Web App Manifest
- Node.js HTTP Server (`server.js`)
