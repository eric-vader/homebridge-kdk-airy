# homebridge-kdk-airy

[![npm version](https://img.shields.io/npm/v/homebridge-kdk-airy)](https://www.npmjs.com/package/homebridge-kdk-airy)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-kdk-airy)](https://www.npmjs.com/package/homebridge-kdk-airy)
[![Build, Lint and Test](https://github.com/eric-vader/homebridge-kdk-airy/actions/workflows/build.yml/badge.svg)](https://github.com/eric-vader/homebridge-kdk-airy/actions/workflows/build.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

Homebridge plugin for KDK and Panasonic Wi-Fi ceiling fans. Supported models are FM10GC, FM12GC, FM14GC and
FM15GC with a light, and FM12EC, FM14EC and FM15EC without one. These are the fans controlled by the KDK Ceiling
Fan app.

The plugin controls the fans over the local network with the ECHONET Lite protocol the app uses. It needs no
account and no internet access. The protocol is documented in [docs/protocol.md](docs/protocol.md).

## Requirements

* Homebridge 2.x
* Node.js 22.22.3 or newer. The 22, 24 and 26 release lines are tested.
* UDP connectivity between Homebridge and the fans: broadcast to port 50125 for discovery, port 3610 in both
  directions for control.

## Installation

Install from the Homebridge UI by searching for `homebridge-kdk-airy`, or run:

```sh
npm install -g homebridge-kdk-airy
```

Then add the platform. The plugin's settings page in the Homebridge UI searches the network for fans, lists them
with model and address, and lets you name each fan and set its per-fan options. Only what you change is saved. The
equivalent `config.json` entry is:

```json
{
  "platform": "KDKAiry",
  "name": "KDK Airy",
  "refresh_interval": 5000,
  "min_request_interval": 100,
  "command_sound": "off"
}
```

| Option | Default | Meaning |
|--------|---------|---------|
| `refresh_interval` | `5000` | Time between state polls of each fan, in ms. 1000 to 60000. |
| `min_request_interval` | `100` | Minimum time between two requests to the same fan, in ms. Applies to polls, commands and the reload after a command. Requests to one fan are sent one at a time. |
| `broadcast_addresses` | all local interfaces | IPv4 broadcast addresses for discovery, comma-separated, for example `"192.168.1.255, 10.0.0.255"`. An array of strings is accepted too. Set this when the fans are on another subnet. |
| `command_sound` | `"off"` | What the fan plays when it applies a command: `"off"`, `"beep"`, `"1"`, `"2"` or `"3"` for a melody. The KDK app uses `"beep"`. |
| `swing_mode` | `"off"` | What the Fan's Swing Mode (Oscillate in the Home app) controls: `"yuragi"` for the 1/f natural-wind fluctuation, `"reverse"` for the reverse direction, `"off"` to hide it. |
| `night_mode_switch` | `true` | Add the hidden Night switch to fans with a light. |
| `allow_unknown_models` | `false` | Register fans whose model code is not in the list above. They are assumed to have a light. |
| `devices` | `[]` | Per-fan settings, matched by HASHGUID: `[{ "guid": "<HASHGUID>", "name": "Study", "swing_mode": "reverse", "night_mode_switch": "hide" }]`. The settings page fills this in. |

Fans are discovered by broadcast when Homebridge starts. Restart Homebridge after adding a fan. Each fan becomes
one accessory, identified by its HASHGUID and named `Fan <ip address>` unless `devices` gives it a name. When a fan
stops answering, discovery runs again, at most once a minute, to find its new address. The plugin never writes to
`config.json`. HomeKit shows the fan's HASHGUID as its serial number: the fans do not report their printed serial
over the network.

Upgrading from version 1: the platform name changed from `KDKAiryHomebridgePlugin` to `KDKAiry`, so edit the
`platform` value in `config.json` or add the platform again from the settings page. The fans are added to HomeKit
afresh.

## HomeKit services

Each fan exposes the following:

| Service | Characteristic | Fan property |
|---------|----------------|--------------|
| Fan | Active | power |
| Fan | Rotation Speed | speed, 10 steps |
| Fan | Rotation Direction | counter-clockwise is the fan's normal direction (`DOWN`, 0x41); clockwise is reverse (`UP`, 0x42) |
| Fan | Swing Mode | hidden by default; `swing_mode` maps it to the 1/f Yuragi natural-wind fluctuation or the reverse direction |
| Light | On, Brightness, Color Temperature | light power, brightness 1 to 100 %, warm to cool white. Adaptive Lighting is supported. In night mode the brightness slider selects the LOW, MEDIUM or HIGH nightlight level. |
| Night | On | night mode; a hidden service, so the Home app does not list it or include it when turning the accessory on. Visible in third-party HomeKit apps such as Eve and usable in automations. |

The Light and Night services exist only on models with a light. Turning Light on selects the normal light mode
unless the light is already on, so a scene that turns everything on leaves night mode alone. Turning Night on
switches to night mode.

Night mode is a Switch rather than a second Lightbulb because an accessory with two Lightbulb services makes the
Home app's Adaptive Lighting setup fail with "Could not complete operation".

A fan error is logged as a warning with its 3-character code. HomeKit's fan service has no fault characteristic.

Off timer, on timer, sleep mode and melodies are part of the protocol layer but are not exposed to HomeKit.
`FanDevice.apply` in `src/device.ts` accepts any writable property. On FM12GC fans with firmware E48GP, sleep
mode is rejected by the fan. See [docs/protocol.md](docs/protocol.md).

Writes that arrive within 50 ms of each other, such as power and speed, are sent as one command, so the fan plays
its command sound once. Changes made while a command is in flight are merged into the next command. Writes that
would not change anything on the fan, such as the repeated colour temperature updates of Adaptive Lighting, are not
sent.

## Troubleshooting

* Run Homebridge with `-D` to log every UDP frame in hex and every discovery reply.
* `Discovery finished: 0 fan(s) answered`: Homebridge and the fans are not on the same broadcast domain. Set
  `broadcast_addresses` to the fans' subnet broadcast address. In Docker, use host networking.
* `not responding`: the fan did not answer three polls in a row. The plugin runs discovery again to find a new
  address and the Home app shows the accessory as No Response until the fan answers.
* `unknown model`: open an issue with the `COMMID` from the log so the model can be added, or set
  `allow_unknown_models`.
* `EADDRINUSE`: another process on the host has UDP port 3610, for example a second copy of this plugin.

## Development

```sh
make check   # lint, type-check, build and test (what CI runs)
make watch   # recompile on every change
make bridge  # Homebridge with debug logging against test/hbConfig; restarts when dist/ changes
make dev     # the same plus the Homebridge web UI at http://localhost:8582, no login
```

`make dev` installs `homebridge-config-ui-x` into `.dev/` on first use. The dev bridge pairs with PIN `031-45-154`.

`src/protocol/` holds the protocol: property codecs, frame codec, request composition, discovery and the UDP
client. `src/device.ts` is the per-fan state, `src/accessory.ts` the HomeKit mapping, `src/platform.ts` the
Homebridge platform and `homebridge-ui/` the settings page. `test/fake-fan.ts` is a UDP fan simulator used by the
tests.

Releasing: `make bump` (or `make bump BUMP=minor`) bumps the version, commits, tags and pushes; then `make release`. It creates the GitHub release
tagged `v` followed by the version, and the `Publish to npm` workflow stages that version on npm using the
`NPM_TOKEN` repository secret, a "Read and write (stage only)" npm access token. A staged version is not public
until it is approved with your npm login and 2FA: `make approve` lists the staged versions and approves the one
you pick. If npm refuses to stage a package that does not exist yet, publish the first release from this machine
with `make publish`.

## License

GPL-3.0. See [LICENSE](LICENSE).
