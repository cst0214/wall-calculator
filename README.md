# Balentino Wall Calculator

A web app that works out how many **WPC Wall Panels** or **Flexible Tiles** a wall needs. For each material it shows the cutting plan, the waste area and the waste rate. It runs on Android and iPhone in the browser and can be added to the home screen.

## How it works
1. **Add a surface.** You can take a photo of the wall and measure one side with a tape measure, or type in the sizes. Round and square columns are supported too.
2. **Mark the wall.** Draw doors, windows, sockets, missing corners and slopes (slanted ceilings, stair walls, gables) on the drawing. Each door, window and socket also has boxes for exact sizes and a ❌ to remove it.
   - **Mistakes are easy to fix.** Every change can be undone or redone with the ↶ ↷ buttons at the top (or Ctrl+Z on a computer). Deleting a wall or opening also shows an "Undo" button in the message at the bottom.
3. **Calculate.** The app shows, for each product and colour:
   - how many pieces to order
   - a cutting plan
   - leftover pieces
   - waste area and waste rate

## Calculation rules
- **WPC panels** are installed vertically by default, and horizontal is an option. Each panel covers its full width: 168 mm for the 24 mm profile and 155 mm for the 10 mm profile. Walls taller than 2900 mm get a joined piece on top.
- **Flexible tiles** (600 × 1200) are never rotated. The user chooses vertical or horizontal laying and the joint width (default: no joint).
- **Leftovers** are only reused when they cover the whole piece. For WPC, the leftover must be at least as long as the height it fills. Leftovers can be used on any surface with the same product and colour.
- **Waste** = material ordered − area actually covered. It only counts cutting waste, not breakage.
- All product sizes can be changed in Settings.

## Files
- `index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js`: the app. It is plain static files, with no build step.
- `tests.html`: open it in a browser to run the calculation checks.
- `tools/serve.ps1`: local test server. Run `powershell -File tools\serve.ps1`, then open http://localhost:8765.
- `tools/make-icons.ps1`: regenerates the PNG icons.

## Publishing
Live at **https://cst0214.github.io/wall-calculator/**. GitHub Pages serves this repo's `main` branch. A push to `main` updates the live app in about a minute, so bump `CACHE` in `sw.js` whenever app files change.

The app needs **HTTPS** for phone cameras and "add to home screen", so any other host must use HTTPS too (for example the company website).

Project history, business rules and open items for whoever continues this work are in [CLAUDE.md](CLAUDE.md).
