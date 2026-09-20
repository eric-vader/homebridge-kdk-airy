# KDK and Panasonic Wi-Fi ceiling fan local protocol

Everything below describes what the **KDK Ceiling Fan** app (version 1.1.2) exchanges with the fans on the local
network. The plugin implements this protocol in `src/protocol/`.

The fan speaks **ECHONET Lite over UDP**. Two ports are involved:

| Port  | Direction        | Purpose                                        |
|-------|------------------|------------------------------------------------|
| 50125 | app → fan (bcast)| discovery request (`M-SEARCH`)                 |
| 3610  | app ↔ fan        | ECHONET Lite control frames (requests and replies) |

## 1. Discovery

The app opens an ordinary UDP socket and broadcasts an SSDP-style search to the
subnet's directed broadcast address (derived from the DHCP IP and netmask):

```
M-SEARCH * HTTP/1.1\r\n
HOST:<broadcast>:50125\r\n
MAN:"ssdp:discover"\r\n
MX:3\r\n
ST:urn:schemas-upnp-org:device:PANA013Adevices:1\r\n
\r\n
```

Timing: the search is sent **3 times, 1 s apart**, then replies are collected for **3 more
seconds**. A discovery run is throttled to at most once every 5 s.

Each fan answers to the socket that sent the search with a text block, lines separated by `\r\n`. This is a
verbatim reply from an FM12GC. `LOCATION` and `DATE` use a colon as separator, `HASHGUID`, `COMMID` and `PARTID`
an equals sign. The app skips one separator character whichever it is, so a parser must accept both:

```
HTTP/1.1 200 OK
CACHE-CONTROL:max-age = 1800
DATE:Mon, 19 Sep 2026 16:10:40 GMT
EXT:
LOCATION:10.1.254.3
HASHGUID=233d15ecf4b4bf7aca3e2bb5ec40bc73ef1b24d813e3d4cf5b2c9b7d2e406bf3
COMMID=FM12GC
PARTID=E48GP
SERVER:OS/Version UPnP/1.0 Product/Version
ST:urn:schemas-upnp-org:device:PANA013Adevices:1
USN:uuid:4D454930-0101-1000-8000-7061bea08d07::urn:schemas-upnp-org:device:PANA013Adevices:1
```

`LOCATION` is the fan's IP, `HASHGUID` (64 hex chars) its unique id, `COMMID` the
model code and `PARTID` the firmware / part id.

The app only accepts replies whose `COMMID` is a known model:

| COMMID  | Light |
|---------|-------|
| FM15GC, FM12GC, FM10GC, FM14GC | yes |
| FM15EC, FM12EC, FM14EC | no |

## 2. Control frames

Frames have this layout:

```
10 81  TIDh TIDl  05 FF 01  01 3A 01  ESV  OPC  [EPC PDC data...] × OPC
│      │          │         │         │    └── number of properties
│      │          │         │         └─────── service code
│      │          │         └───────────────── destination object 01 3A 01
│      │          └─────────────────────────── source object 05 FF 01 (controller)
│      └────────────────────────────────────── transaction id, 1..65535, wraps to 1
└───────────────────────────────────────────── ECHONET Lite header (EHD1 EHD2)
```

| ESV  | Meaning                         |
|------|---------------------------------|
| 0x61 | SetC: write, response expected |
| 0x62 | Get: read                      |
| 0x71 | Set_Res: write succeeded       |
| 0x51 | SetC_SNA: write failed         |
| 0x72 | Get_Res: read succeeded        |
| 0x52 | Get_SNA: read failed           |

Each property is `EPC PDC data` (PDC = data length). A **Get** request carries PDC = 0 and no data. A
Get_Res carries the current values; a property the fan could not answer comes back with PDC 0.

The fan sends its reply **to the requester's IP address on port 3610** regardless of the port the request came
from. The app listens on a `MulticastSocket(3610)` and sends from short-lived sockets. The reply's own source port
is ephemeral. Replies are matched to requests by the TID. The app waits 10 s for a reply before declaring a
timeout. Measured on an FM12GC, a Get answers in under a second and a SetC followed by a full Get takes about
1.3 s. An occasional request goes unanswered, so the plugin re-sends a timed-out SetC once.

Example: read fan power and speed (TID 1):

```
>>> 10 81 00 01 05 FF 01 01 3A 01 62 02  80 00  F0 00
<<< 10 81 00 01 05 FF 01 01 3A 01 72 02  80 01 30  F0 01 36      (power ON, speed 6)
```

Example: turn the fan on (as captured from the app, TID 0):

```
>>> 1081000005ff01013a0161 01 800130
<<< 1081000005ff01013a0171 01 8000
```

## 3. Properties

| EPC  | Name                        | PDC | Values                                                         | R/W |
|------|-----------------------------|-----|----------------------------------------------------------------|-----|
| 0x80 | FanPower                    | 1   | `0x30` ON, `0x31` OFF                                          | RW  |
| 0xF0 | FanVolume                   | 1   | `0x31`..`0x3A`: 10 speed steps                                | RW  |
| 0xF1 | FanDirection                | 1   | `0x41` DOWN (normal), `0x42` UP (reverse)                      | RW  |
| 0xF2 | FanFluctuation              | 1   | `0x30` ON, `0x31` OFF: "1/f" natural-wind mode                | RW  |
| 0xF3 | LightPower                  | 1   | `0x30` ON, `0x31` OFF                                          | RW (light models) |
| 0xF4 | LightMode                   | 1   | `0x42` NORMAL, `0x43` NIGHT                                    | RW  |
| 0xF5 | LightBrightness             | 1   | 1..100 (percent, normal mode)                                  | RW  |
| 0xF6 | LightColour                 | 1   | 0..100: 0 warm white … 100 cool white                         | RW  |
| 0xF7 | LightNightlightBrightness   | 1   | `1` LOW, `50` MEDIUM, `100` HIGH (night mode only)             | RW  |
| 0xF8 | OffTimer                    | 4   | `status sleep hour minute`: see timers                        | RW  |
| 0xF9 | OffTimerRemainTime          | 2   | `hour minute` remaining                                        | R   |
| 0xFA | OnTimer                     | 4   | `status melody hour minute`: see timers                       | RW  |
| 0xFB | OnTimerRemainTime           | 2   | `hour minute` remaining                                        | R   |
| 0x86 | ErrorCode                   | 46  | 3 ASCII characters at data offset 6..8                         | R   |
| 0x88 | ErrorStatus                 | 1   | `0x41` error, `0x42` no error                                  | R   |
| 0x8C | ProductCode                 | 18  | 7 ASCII characters at offset 0..6                              | R   |
| 0x93 | RemoteCtlSetting            | 1   | `0x41`, `0x42` (app), `0x61`, `0x62`: control option, LAN app never sends it | W |
| 0xFD | CtlOptSource                | 1   | `3` app on the LAN; other values belong to control paths the plugin does not use | W   |
| 0xFC | BuzzerSet                   | 1   | `0x30` beep on command, `0x31` silent: control option         | W   |
| 0xFE | Melody                      | 1   | `0x40` none, `0x41`..`0x43` melodies 1 to 3: control option   | W   |

### Timers

`OffTimer` is `status, sleep, hour, minute`. `OnTimer` is `status, melody, hour, minute`.

* `status`: `0x30` timer ON, `0x31` timer OFF, `0xFF` keep.
* `sleep` (off timer): `0x30` sleep mode ON, `0x31` OFF, `0xFF` keep. Sleep mode gradually winds the fan down
  before switching off. While sleep is on the fan refuses speed/direction/fluctuation writes.
* `melody` (on timer): `0x40` none, `0x41`..`0x43`, `0xFF` keep.
* `hour` 0..23 / `minute` 0..59 are a **duration from now** (app default 2 h 00 min), or `0xFF` to keep the
  running countdown. The remaining time is read back through 0xF9 / 0xFB.

Observed on FM12GC firmware E48GP: every frame with `sleep = 0x30` is answered with SetC_SNA (0x51), whether the
frame carries only the timer, the timer with fan properties, an explicit or KEEP duration, a running timer or the
buzzer on. The same frame with `sleep = 0x31` or `0xFF` is accepted. This model or firmware does not support sleep
mode, although the app's model table does not distinguish it.

App actions:

| Action               | Payload                                          |
|----------------------|--------------------------------------------------|
| Set OFF timer 1h30   | `F8 04 30 31 01 1E`                              |
| Sleep mode on / off  | `F8 04 30 30 FF FF` / `F8 04 30 31 FF FF`        |
| Remove OFF timer     | `F8 04 31 31 FF FF`                              |
| Set ON timer 2h, melody 1 | `FA 04 30 41 02 00`                         |
| Remove ON timer      | `FA 04 31 FF FF FF`                              |

## 4. What the app sends

### Status read

A Get with, in order: `80 F0 F1 F2` `[F3 F4 F5 F6 F7 if the model has a light]` `F8 F9 FA FB 86 88`.
The app does this after start-up, on pull-to-refresh and after every successful write.

### Write

The app never writes a single property. It:

1. merges the changed values into the last known full state,
2. drops the control options (0x93, 0xFD, 0xFC, 0xFE) and the read-only properties (0x86, 0x88, 0xF9, 0xFB),
3. sets `hour`/`minute` of any timer that was **not** part of the change to `0xFF` (keep),
4. prunes properties the fan would reject in the target state:
   * fan OFF → drop FanVolume, FanDirection, FanFluctuation, OffTimer
   * fan ON → drop OnTimer
   * fan ON and OffTimer.sleep ON → also drop FanVolume, FanDirection, FanFluctuation, OnTimer
   * light OFF → drop LightMode, LightBrightness, LightColour, LightNightlightBrightness
   * light ON in NORMAL mode → drop LightNightlightBrightness
   * light ON in NIGHT mode → drop LightBrightness, LightColour
5. prepends `CtlOptSource = 3`, `BuzzerSet = ON`, `Melody = none`,
6. sends it as SetC (0x61), waits for 0x71, then does a full status read.

The plugin reproduces this in `src/protocol/compose.ts`. It differs in step 5: `BuzzerSet` and `Melody` come from
the `command_sound` option, and `BuzzerSet` defaults to OFF.
