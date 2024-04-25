const http = require('http');
const url = require('url');
const { exec } = require("node:child_process");

function sendPlainText(res, data) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(data);
}

function sendJSON(res, data, forceGC = false) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  let json = JSON.stringify(data);
  if (forceGC && global.gc) {
    data = null;
    global.gc();
  }
  res.end(json);
}

function sendError(res, error) {
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/plain');
  res.end(error + '\n');
  console.log(error);
}

function execAdb(cmd) {
  return new Promise((resolve, reject) => {
    exec("adb " + cmd, {maxBuffer: 1024 * 1024 * 50},
         (error, stdout, stderr) => {
           if (error) {
             console.log(`error: ${error.message}`);
             reject(error);
             return;
           }
           if (stderr) {
             console.log(`stderr: ${stderr}`);
             reject(stderr);
             return;
           }
           resolve(stdout);
         })
  });
}

async function getLogcatEvents(startTime) {
  let result = [];
  let stdout = await execAdb(`logcat -t ${startTime || 1000} --format=epoch,UTC,usec,printable,long`);
  let sections = stdout.split("--------- beginning of ");
  for (let section of sections) {
    let lineBreakIndex = section.indexOf("\n");
    if (lineBreakIndex == -1) {
      continue;
    }
    let sectionName = section.slice(0, lineBreakIndex);
    let messages = section.slice(lineBreakIndex + 1).split("\n\n");
    for (let messageText of messages) {
      if (!messageText) {
        continue;
      }
      let match = messageText.match(/\[\s+([0-9.]+)\s+([0-9]+):\s*([0-9]+) ([A-Z])\/(.*[^ ]) +\]\n(.*)/);
      if (!match) {
        console.log("failed to parse:", messageText);
        continue;
      }
      let [, time, pid, tid, level, tag, msg] = match;
      result.push({section: sectionName, time: parseFloat(time),
                   pid, tid: parseInt(tid), level, tag, msg});
    }
  }

  return result;
}

async function getBatteryStatsEvents() {
  let stdout = await execAdb("shell dumpsys batterystats -c --history");
  let events = [];
  let stringTable = [];
  let lines = stdout.split("\n");
  let resetTime;
  let lastTime;
  for (let line of lines) {
    if (line.startsWith("9,hsp,")) {
      let [, , index, uid, str] = line.split(",");
      stringTable[parseInt(index)] = {uid, str};
    }
    if (line.startsWith("9,h,")) {
      line = line.slice("9,h,".length);
      if (line.startsWith("0:RESET:TIME:")) {
        resetTime = parseInt(line.slice("0:RESET:TIME:".length));
        lastTime = resetTime;
      } else {
        if (line.includes(",")) {
          let parts = line.split(",");
          let increment = parseInt(parts[0]);
          for (let i = 1; i < parts.length; ++i) {
            events.push({time: lastTime + increment, event: parts[i]});
          }
          if (increment > 0) {
            lastTime += increment;
          }
        } else {
          lastTime += parseInt(line);
        }
      }
    }
  }
  return {events, stringTable, resetTime};
}

const phase_instant = 0;
const phase_interval = 1;
const phase_start = 2;
const phase_end = 3;
const marker_schema = {
  name: 0,
  startTime: 1,
  endTime: 2,
  phase: 3,
  category: 4,
  data: 5
};

function convertCheckinNames(events, stringTable) {
  let nameMap = new Map([
    ["r", "running"],
    ["w", "wake_lock"],
    ["s", "sensor"],
    ["g", "gps"],
    ["Wl", "wifi_full_lock"],
    ["Ws", "wifi_scan"],
    ["Wm", "wifi_multicast"],
    ["Wr", "wifi_radio"],
    ["Pr", "mobile_radio"],
    ["Psc", "phone_scanning"],
    ["a", "audio"],
    ["S", "screen"],
    ["BP", "plugged"],
    ["Sd", "screen_doze"],
    ["Pcn", "data_conn"],
    ["Pst", "phone_state"],
    ["Pss", "phone_signal_strength"],
    ["Sb", "brightness"],
    ["ps", "power_save"],
    ["v", "video"],
    ["Ww", "wifi_running"],
    ["W", "wifi"],
    ["fl", "flashlight"],
    ["di", "device_idle"],
    ["ch", "charging"],
    ["Ud", "usb_data"],
    ["Pcl", "phone_in_call"],
    ["b", "bluetooth"],
    ["Wss", "wifi_signal_strength"],
    ["Wsp", "wifi_suppl"],
    ["ca", "camera"],
    ["bles", "ble_scan"],
    ["Chtp", "cellular_high_tx_power"],
    ["Gss", "gps_signal_quality"],
    ["nrs", "nr_state"],
    ["Bl", "battery_level"],
    ["Bs", "battery_status"],
    ["Bh", "battery_health"],
    ["Bp", "plug"],
    ["Bt", "battery_temperature"],
    ["Bv", "battery_voltage_mV"],
    ["Bcc", "charge_mAh"],
    ["Mrc", "modemRailCharge_mAh"],
    ["Wrc", "wifiRailCharge_mAh"],
    ["wr", "wake_reason"],
    ["Ev", "event"]
  ]);

  let valueMaps = new Map([
    ["Pst", new Map([
      ["in", "in"],
      ["out", "out"],
      ["em", "emergency"],
      ["off", "off"],   
    ])],
    ["Pss", new Map([
      ["0", "none"],
      ["1", "poor"],
      ["2", "moderate"],
      ["3", "good"],
      ["4", "great"]
    ])],
    ["Sb", new Map([
      ["0", "dark"],
      ["1", "dim"],
      ["2", "medium"],
      ["3", "light"],
      ["4", "bright"]
    ])],
    ["Wsp", new Map([
      ["inv", "invalid"],
      ["dsc", "disconn"],
      ["dis", "disabled"],
      ["inact", "inactive"],
      ["scan", "scanning"],
      ["auth", "authenticating"],
      ["ascing", "associating"],
      ["asced", "associated"],
      ["4-way", "4-way-handshake"],
      ["group", "group-handshake"],
      ["compl", "completed"],
      ["dorm", "dormant"],
      ["uninit", "uninit"]
    ])],
    ["nrs", new Map([
      ["0", "none"],
      ["1", "restricted"],
      ["2", "not_restricted"],
      ["3", "connected"]
    ])],
    ["Bs", new Map([
      ["?", "unknown"],
      ["c", "charging"],
      ["d", "discharging"],
      ["n", "not-charging"],
      ["f", "full"],
    ])],
    ["Bh", new Map([
      ["?", "unknown"],
      ["g", "good"],
      ["h", "overheat"],
      ["d", "dead"],
      ["v", "over-voltage"],
      ["f", "failure"],
      ["c", "cold"],
    ])],
    ["Bp", new Map([
      ["n", "none"],
      ["a", "ac"],
      ["u", "usb"],
      ["w", "wireless"],
    ])]
  ]);

  const longEventNames = [
    "null", "proc", "fg", "top", "sync", "wake_lock_in", "job", "user",
    "userfg", "conn", "active", "pkginst", "pkgunin", "alarm", "stats",
    "pkginactive", "pkgactive", "tmpwhitelist", "screenwake", "wakeupap",
    "longwake", "est_capacity"
  ];
  const shortEventnames = [
    "nl", "pr", "fg", "tp", "sy", "wl", "jb", "ur", "uf", "cn", "ac", "pi",
    "pu", "al", "st", "ai", "aa", "tw", "sw", "wa", "lw", "ec"
  ];
  
  return events.map(({time, event}) => {
    let name, phase;
    if (event.startsWith("+")) {
      phase = phase_start;
      name = event.slice(1);
    } else if (event.startsWith("-")) {
      phase = phase_end;
      name = event.slice(1);
    } else {
      phase = phase_instant;
      name = event;
    }

    // The +w= entries are matched with -w entries.
    if (name.startsWith("w=")) {
      name = "w";
    }

    let data = {raw: event};
    let parsed = name.match(/^E([a-z]{2})=([0-9]+)$/);
    if (parsed) {
      let {uid, str} = stringTable[parseInt(parsed[2])];
      let eventNameIndex = shortEventnames.indexOf(parsed[1]);
      name = `${eventNameIndex != -1 ? longEventNames[eventNameIndex] : parsed[1]}=${
        str.replace(/^"/, "").replace(/"$/, "")}`;
      if (uid != "0") {
        data.uid = parseInt(uid);
      }
    } else if (nameMap.has(name)) {
      name = nameMap.get(name);
    }
    if (name.includes("=")) {
      let index = name.indexOf("=");
      let id = name.slice(0, index);
      if (nameMap.has(id)) {
        let val = name.slice(index + 1);
        if (valueMaps.has(id)) {
          let map = valueMaps.get(id);
          if (map.has(val)) {
            val = map.get(val);
          }
        }
        name = nameMap.get(id) + "=" + val;
      }
    }

    // [name, startTime, endTime, phase, category, data]
    return [name, phase != phase_end ? time : null,
            phase == phase_end ? time : null, phase, 0, data];
  });
}

function mergeIntervalMarkers(markers) {
  let toRemove = new Set();
  let starts = new Map();
  for (let i = 0; i < markers.length; ++i) {
    let marker = markers[i];
    if (marker[marker_schema.phase] == phase_start) {
      let raw = marker[marker_schema.data].raw;
      if (raw.startsWith("+")) {
        starts.set(raw.slice(1), i);
      }
    }
    if (marker[marker_schema.phase] == phase_end) {
      let raw = marker[marker_schema.data].raw;
      if (raw.startsWith("-")) {
        raw = raw.slice(1);
        let startIndex = starts.get(raw);
        if (startIndex !== undefined) {
          let startMarker = markers[startIndex];
          starts.delete(raw);
          toRemove.add(startIndex);
          marker[marker_schema.phase] = phase_interval;
          marker[marker_schema.startTime] = startMarker[marker_schema.startTime];
          marker[marker_schema.data].raw =
            startMarker[marker_schema.data].raw + " " + marker[marker_schema.data].raw;
        }
      }
    }
  }
  return markers.filter((m, i) => !toRemove.has(i));
}

async function markersFromAdb(startTime = 0) {
  let {events, stringTable} = await getBatteryStatsEvents();
  let categories = [
    {name: "Android - BatteryStats", color: "yellow", subcategories: ["Other"]}
  ];

  let markers = convertCheckinNames(events, stringTable);
  markers = mergeIntervalMarkers(markers);

  const schema = marker_schema;
  markers = markers.filter(m =>  m[(m[schema.phase] == phase_end || m[schema.phase] == phase_interval) ? schema.endTime : schema.startTime] > startTime);
  markers.forEach(m => {
    let phase = m[schema.phase];
    if (phase != phase_end) {
      let startIndex = schema.startTime;
      m[startIndex] = m[startIndex] - startTime;
    }
    if (phase == phase_end || phase == phase_interval) {
      let endIndex = schema.endTime;
      m[endIndex] = m[endIndex] - startTime;
    }

    let data = m[schema.data];
    data.type = "abs";
    
    let name = m[schema.name];
    if (name.includes("=")) {
      let index = name.indexOf("=");
      let val = name.slice(index + 1);
      if (val) {
        data.name = val;
      }
      m[schema.name] = name.slice(0, index);
    }
  });

  let markerSchema = [
    {
      name: "abs",
      tooltipLabel:"{marker.name} {marker.data.name}",
      tableLabel:"{marker.data.name}",
      chartLabel:"{marker.data.name}",
      display: ["marker-chart", "marker-table"],
      data: [
        {
          key: "name",
          label: "Name event",
          format: "string",
          searchable: true
        },
        {
          key: "uid",
          label: "User id",
          format: "string",
          searchable: true
        },
        {
          key: "raw",
          label: "Checkin event",
          format: "string"
        },
      ],
    },
    {
      name: "alc",
      tooltipLabel:"{marker.name} {marker.data.msg}",
      tableLabel:"[{marker.data.section}] {marker.data.level} — {marker.data.msg}",
      display: ["marker-chart", "marker-table"],
      data: [
        {
          key: "msg",
          label: "Message",
          format: "string",
          searchable: true
        },
        {
          key: "level",
          label: "Log level",
          format: "string",
          searchable: true
        },
        {
          key: "pid",
          label: "Process",
          format: "pid",
          searchable: true
        },
        {
          key: "tid",
          label: "Thread",
          format: "tid",
          searchable: true
        },
        {
          key: "section",
          label: "Section",
          format: "string"
        },
      ],
    }
  ];

  categories.push({name: "Android - logcat", color: "yellow", subcategories: ["Other"]});
  const catId = 1;
  let messages = await getLogcatEvents(startTime / 1000);
  const levelMap = new Map([
    ["V", "Verbose"],
    ["D", "Debug"],
    ["I", "Info"],
    ["W", "Warning"],
    ["E", "Error"],
    ["F", "Fatal"],
  ]);
  for (let {section, time, pid, tid, level, tag, msg} of messages) {
    level = levelMap.get(level) || level;
    markers.push([tag, time * 1000 - startTime, null, phase_instant, catId,
                  {type: "alc", msg, level, pid, tid, section}]);
  }

  return {categories, markers: {data: markers, schema}, markerSchema};
}

function resetTime() {
  let now = Date.now();
  while (now % 1000) {
    now = Date.now();
  }
  const date = new Date(now);
  function twoDigits(s) { return ("0"+s).slice(-2); }

  let str = twoDigits(date.getMonth() + 1) + twoDigits(date.getDate()) +
      twoDigits(date.getHours()) + twoDigits(date.getMinutes()) +
      twoDigits(date.getYear()) + "." + twoDigits(date.getSeconds());
  return execAdb("shell su -c date " + str);
}

const app = async (req, res) => {
  console.log(new Date(), req.url);

  if (req.url == "/reset") {
    sendPlainText(res,
                  [await execAdb("shell dumpsys battery unplug"),
                   await execAdb("shell dumpsys batterystats --reset"),
                   await execAdb("shell dumpsys batterystats --enable full-history"),
                   await resetTime()].join("\n"));
    return;
  }

  if (req.url == "/dump") {
    sendPlainText(res, await execAdb("shell dumpsys batterystats -c"));
    return;
  }

  if (req.url == "/dump-verbose") {
    sendPlainText(res, await execAdb("shell dumpsys batterystats"));
    return;
  }

  if (req.url == "/events") {
    let {events, stringTable, resetTime} = await getBatteryStatsEvents();
    sendPlainText(res,
                  stringTable.map((s, i) => `${i}=${s.uid},${s.str}`).join("\n") +
                  "\n\n" +
                  events.map(e => `${e.time - resetTime}, ${e.event}`).join("\n"));
    return;
  }

  if (req.url == "/events.json") {
    let {events, stringTable} = await getBatteryStatsEvents();
    sendPlainText(res,
                  convertCheckinNames(events, stringTable).map(JSON.stringify).join("\n"));
    return;
  }
  
  if (req.url == "/logcat.json") {
    let data = await getLogcatEvents();
    sendPlainText(res, data.map(JSON.stringify).join("\n"));
    return;
  }

  if (req.url.startsWith("/markers")) {
    const query = url.parse(req.url, true).query;
    if (!query.start && !query.end) {
      sendError(res, "markers: unexpected case");
      return;
    }

    sendJSON(res, await markersFromAdb(parseFloat(query.start)));
  }

  if (req.url.startsWith("/profile")) {
    let prof = await new Promise((resolve, reject) => {
      http.get("http://localhost:2121/profile", res => {
        let data = "";
        res.on("data", chunk => {
          data += chunk;
        });

        res.on("end", () => {
          resolve(JSON.parse(data));
        });
      }).on("error", reject);
    });

    // remove existing markers
    let firstThread = prof.threads[0]
    firstThread.stringArray = ["(root)"];
    let markers = firstThread.markers;
    for (let key of ["data", "name", "startTime", "endTime", "phase", "category"]) {
      markers[key] = [];
    }
    markers.length = 0;

    // Now add adb markers.
    let adbMarkers = await markersFromAdb(prof.meta.startTime);
    prof.meta.markerSchema = adbMarkers.markerSchema;
    let originalCategoryCount = prof.meta.categories.length;
    for (let category of adbMarkers.categories) {
      prof.meta.categories.push(category);
    }
    let schema = adbMarkers.markers.schema;
    for (let marker of adbMarkers.markers.data) {
      markers.phase.push(marker[schema.phase]);
      markers.data.push(marker[schema.data]);
      let name = marker[schema.name];
      let index = firstThread.stringArray.indexOf(name);
      if (index == -1) {
        index = firstThread.stringArray.push(name) - 1;
      }
      markers.name.push(index);
      markers.startTime.push(marker[schema.startTime]);
      markers.endTime.push(marker[schema.endTime]);
      markers.category.push(marker[schema.category] + originalCategoryCount);
      markers.length++;
    }

    try {
      sendJSON(res, prof, true);
    } catch (err) {
      sendError(res, 'profile: ' + err);
    }
    return;
  }
};

const port = process.env.PORT || 2222;
const server = http.createServer(app)
server.listen(port, "0.0.0.0", () => {
  console.log(`Ensure devtools.performance.recording.markers.external-url is set to http://localhost:${port}/markers in 'about:config'.`);
});
