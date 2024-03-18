# adb-markers
Generate markers to include in the Firefox Profiler from adb commands

# Usage

Running `node adb-markers.js` will start a server on `localhost:2222`.

## Adding markers to profiles captured by the Firefox Profiler through remote profiling
In Firefox 125 or later configured for remote profiling a Firefox instance on Android:
- on the host computer, in `about:config`, set the `devtools.performance.recording.markers.external-url` preference to `http://localhost:2222/markers`.
- use the 'power' preset (or any configuration that uses the 'power' feature) when starting the profiler.
- when capturing the profile, the Firefox Profiler will automatically fetch additional markers from `adb shell dumpsys batterystats` and `adb logcat`, and add them to the profile.

## Adding markers to a profile from an USB power meter

- ensure [USB power profiling](https://github.com/fqueze/usb-power-profiling) works, and `http://localhost:2121/profile` returns valid profiles.
- [Load](https://profiler.firefox.com/from-url/http%3A%2F%2Flocalhost%3A2222%2Fprofile/calltree/?v=10) `http://localhost:2222/profile` in the [Firefox Profiler](https://profiler.firefox.com). 

## HTTP API
- `GET /markers?start=<start timestamp in ms>&end=<end timestamp in ms>` returns JSON data containing markers that can be added to a gecko profile by the Firefox Profiler front-end.
The data contains: an array of categories, a markers data table, and an array of marker schemas.  
The start timestamp should be `profile.meta.startTime + profile.meta.profilingStartTime` from the profile and the end timestamp should be `profile.meta.startTime + profile.meta.profilingEndTime`.
- `GET /profile` will return a profile retrieved from `http://localhost:2121/profile` extended with markers from `adb`. You can view it by [loading it](https://profiler.firefox.com/from-url/http%3A%2F%2Flocalhost%3A2222%2Fprofile/calltree/?v=10) in the [Firefox Profiler](https://profiler.firefox.com).
- `GET /reset` will issue `adb` commands meant to put the phone in a state where it will produce the data this script expects:
  - `adb shell dumpsys battery unplug`: Android only adds data to battery stats when using the device on battery or when charing the battery. It stops adding data once the battery is full. This command works around the issue by mocking an unplugged battery state.
  - `adb shell dumpsys batterystats --reset`: resets the batterystats history. For unkown reasons, the timestamps drift slowly over time (eg. off by a few minutes after a few days), so resetting the history when starting a profiling session increases the accuracy of marker timestamps.
  - `adb shell dumpsys batterystats --enable full-history`: make the batterystats history include events about processes.
- Debugging APIs:
  - `GET /dump`: dump the raw output of `adb shell dumpsys batterystats -c` (`-c` here means 'checkin', ie the machine readable output format of batterystats).
  - `GET /dump-verbose`: dump the (mostly) human readable output of `adb shell dumpsys batterystats`.
  - `GET /events`: dump the batterystats events in plain text.
  - `GET /events.json`: dump the batterystats events as JSON objects.
  - `GET /logcat.json`: dump the last 1000 logcat messages as JSON objects.
