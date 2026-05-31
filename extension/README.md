# Clip-Direct extension

## Install

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → this `extension/` directory
3. **Options:** server URL e.g. `http://localhost:8090/`, storage **PC** (default)

## Service worker inactive

Normal when no tabs are using the extension; it wakes on clicks and network events.

## After an update

Reload the extension on `chrome://extensions`, then refresh open video tabs (F5). A banner may ask you to reload if the extension context was invalidated.

## Troubleshooting

- **Server unreachable:** start backend (`docker compose up` or `python -m backend.main`), test `http://localhost:8090/` in the browser.
- **Wrong URL in options:** must end with `/`, e.g. `http://localhost:8090/`
- **“Receiving end does not exist”:** reload the video page (F5).
