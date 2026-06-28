# Projection Mapping Portal

A real-time parallax portal experience for Snap Spectacles 2024 and a projector. Point a projector at a wall, wear the glasses, pinch the 4 corners of the projected image — the 3D scene inside it shifts perspective as you move your head, like a window into another space.

---

## How it works

A projector shows a 3D scene on the wall. Snap Spectacles track your head position in real time and stream it over WebSocket to the laptop running the web app. The web app uses an off-axis frustum projection to recompute the exact viewpoint each frame based on where your head actually is — so the scene parallaxes correctly as you move, the same way a real window would.

Calibration is done in AR: you pinch each corner of the projected rectangle while wearing the glasses, and the system builds the coordinate mapping automatically. No physical measurements, no desktop calibration software.

---

## Requirements

- Snap Spectacles 2024
- A projector pointed at a flat wall
- A laptop on the same Wi-Fi network as the Spectacles
- Node.js (v18+)

---

## Setup

**1. Start the web server**

```bash
cd web
npm install
node server.js
```

The terminal will print the local URL and WebSocket address, e.g. `http://192.168.0.101:3000`. Open that URL in a browser on the laptop and leave it running.

**2. Load the Lens**

Open the project in Lens Studio and push the Lens to your Spectacles. When prompted, enter the WebSocket URL shown in the terminal (e.g. `ws://192.168.0.101:8765`) — it's pre-filled on the splash screen.

**3. Calibrate**

Put on the Spectacles. The Lens will connect to the relay automatically. Point your hand at each of the 4 corners of the projected image on the wall and pinch to place a marker. Order doesn't matter — the system auto-sorts them. After the 4th corner, a Confirm button appears floating in the centre — pinch it to lock in the calibration.

**4. Experience**

Move your head left, right, up, down. The scene shifts in parallax. The projector image stays fixed on the wall but appears to have depth behind it.

---

## Controls (web app)

| Action | How |
|---|---|
| Enter edit mode | Click **Edit** or press `T` |
| Move model | Shift + Arrow keys, or drag in edit mode |
| Scale model | `[` and `]` |
| Depth (push back/forward) | Shift + `W` / `S` |
| Upload 3D model | Drag a GLB/GLTF onto the window, or use the panel |
| Upload portal frame | Panel → Portal frame → Upload image / GIF |

### Customisable in the panel

- **3D model** — upload any GLB/GLTF file
- **Portal frame** — PNG or GIF overlaid on the projection edges
- **Background colour** — scene sky colour
- **Exposure** — brightness / tone mapping
- **Model transform** — position, rotation, scale, depth
- **Movement bounds (X / Y / Z)** — how far the parallax camera can drift before clamping; visible as a teal wireframe box in edit mode. Reduce Z to prevent depth-of-field shift when walking toward/away from the wall

---

## Project structure

```
Assets/Scripts/
  ProjectionMappingController.ts   — corner placement, auto-sort, calibration lock, pose streaming
  OnboardingController.ts          — AR onboarding state machine (connecting → calibrating → confirming → live)

web/
  server.js                        — Node.js WebSocket relay + static file server
  public/
    app.js                         — Three.js scene, parallax, model loading, UI
    calibration.js                 — coordinate mapping from Specs space to web space
    portal-projection.js           — off-axis frustum projection
    orbit-debug.js                 — edit-mode orbit camera and portal frame visualiser
    index.html
    styles.css
```

---

## Tech stack

- **Spectacles side:** TypeScript, Lens Studio, SpectaclesInteractionKit, SpectaclesUIKit, WorldQueryModule
- **Web side:** vanilla JavaScript (ES modules), Three.js
- **Server:** Node.js, `ws`

No build step — the web side is plain ES modules served directly.

---

## Made by

Kavin Kumar Balamurugan — [rbkavin.studio](https://rbkavin.studio/k/)
