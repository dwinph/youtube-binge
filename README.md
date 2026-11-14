# YouTube Binge (Oldest First)

A Safari userscript that plays a YouTube channel's videos from oldest to newest, on the real YouTube site. You're signed in, so every video you watch lands in your own watch history, with the red progress bar, on all your devices.

## How it works

1. Open any channel page, for example `youtube.com/@somechannel`.
2. Click **▶ Binge oldest → newest** in the bottom-right corner.
3. The script loads the channel's full upload list, flips it to oldest first, skips anything you've already watched (90% or more), and opens the first unwatched video.
4. When a video ends, it opens the next one. A small panel on the watch page shows where you are and gives you Prev, Next, Pause auto-next, Refresh (picks up new uploads), Stop, and a minimize button.

Click the same button later to pick up where you left off. It reloads the list and starts at the first video you haven't finished.

By default it uses the channel's long-form uploads only, without Shorts or past livestreams. If a channel has no regular videos, it falls back to all uploads.

Your queue position is saved in Safari's storage for youtube.com, on that device. Your watch history itself lives on your YouTube account.

## Install on Mac

1. Install the free **Userscripts** app from the Mac App Store (by Justin Wasack).
2. Open the app and pick a folder to keep scripts in.
3. In Safari, go to Settings, then Extensions, turn on **Userscripts**, and allow it on `youtube.com`.
4. Copy `youtube-binge.user.js` into the scripts folder. Or open the Userscripts toolbar button, choose Open Extension Page, create a new JavaScript file, and paste the script in.
5. Reload YouTube.

## Install on iPhone or iPad

1. Install **Userscripts** from the App Store.
2. Open the app and set the scripts folder, for example a folder in iCloud Drive.
3. Go to the Settings app, then Safari, then Extensions, turn on Userscripts, and allow it on `youtube.com` and `m.youtube.com`.
4. Save `youtube-binge.user.js` into that folder using the Files app.
5. Open YouTube in Safari, not the YouTube app.

## Let videos auto-play

Safari may block the next video from starting on its own. To fix that:

- **Mac:** on youtube.com, open Safari, then Settings for youtube.com, and set Auto-Play to **Allow All Auto-Play**.
- **iPhone:** if the next video loads but doesn't start, tap play. iOS is stricter about auto-play than the Mac.

## Troubleshooting

- **The button doesn't show:** make sure Userscripts is allowed on youtube.com, then reload the page.
- **"Could not read YouTube settings":** reload the page. This can happen right after Safari wakes from sleep.
- **Watched videos aren't skipped:** make sure you're signed in to YouTube in Safari. Watched marks come from your account.
- Open the Web Inspector console and look for lines starting with `[yt-binge]`.

## Limits

- It relies on YouTube's internal web API, the same one the YouTube site uses. If YouTube changes it, the script may need an update.
- Moving to the next video is a full page load, which is simple and reliable but not seamless.
