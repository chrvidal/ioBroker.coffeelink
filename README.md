# ioBroker.coffeelink

Read status and counters from the De'Longhi Coffee Link cloud. Enable LAN for
direct statistics and local controls on PrimaDonna Soul machines.

[De'Longhi Coffee Link machines](https://www.delonghi.com/)

## Installation and test releases

Install the published npm package with `iobroker add coffeelink`.

Preview builds and release notes are available on the
[GitHub releases page](https://github.com/chrvidal/ioBroker.coffeelink/releases).
LAN controls have been tested on a PrimaDonna Soul ECAM612.55. Feedback from
other PrimaDonna Soul models is welcome.

## Setup

1. Add a Coffee Link instance in ioBroker Admin.
2. Enter the email address and password from the Coffee Link app. ioBroker
   encrypts the stored password.
3. Save the instance. The default cloud polling interval is 15 minutes.

Cloud mode is read-only and works without a local connection to the machine.
The adapter supports European (EU) Coffee Link accounts. An account in another
region may get a login error even with the correct credentials.
An online cloud status means that the service reports the machine online.
Check the status and counter timestamps when you need to know how recent a
value is.

### Local network

Local access is optional. It has been tested with a PrimaDonna Soul
ECAM612.55. The adapter recognizes the ECAM610, ECAM612 and ECAM613 families
as PrimaDonna Soul. Other Coffee Link models show only the `cloud` branch.
With LAN enabled and no supported machine on the account, the LAN status is
`unsupported-model`.

1. Select **Enable LAN** and enter the machine's LAN IPv4 address. The adapter
   uses the host address selected by the route to the machine.
2. Save to enable local statistics and controls.
   The adapter registers one machine at a time. Registration may interrupt
   the official Coffee Link app's local connection.
3. Check `info.lan.status`. The value `verified` means the adapter received
   authenticated machine data. If there is a firewall between the host and the
   machine, the machine must be able to reach the host on TCP port 10275.
   Existing installations with a custom callback port keep using it.

If LAN callbacks stop for five minutes, the adapter checks the connection with
a read before registering again. The app's local connection may be interrupted
when the adapter re-registers.

## Objects

Each machine appears below `coffeelink.<instance>.machines.<id>`.

| Branch | Contents |
| --- | --- |
| `cloud.counters` | Lifetime counters reported by Coffee Link |
| `cloud.diagnostics` | When the cloud last changed its coffee and milk totals |
| `lan.statistics` | Direct machine-wide totals for drinks, water, descaling and other maintenance |
| `lan.control` | Power, stop, auto-off delay and water hardness |
| `lan.control.profiles` | Named machine profiles with drink buttons for manual use |
| `lan.diagnostics` | Read buttons and the results of LAN requests |

Cloud totals can lag behind the values on the machine. Use LAN statistics
to compare with the totals on the machine display. If a statistics refresh
only returns some pages, the adapter keeps the previous values for the
missing pages and reports a partial result.
Drink counts shown by the adapter are machine totals. Cloud maintenance counters
can differ from the machine: on the reference ECAM612.55, the cloud filter count
was 0 while the LAN statistics reported 35. Prefer `lan.statistics.filters` for
the filter total. The meaning of the cloud grounds counter has not been verified;
do not assume that it counts the same events as `lan.statistics.grounds`.

### Controls

To press a button, write `true` with `ack: false`. The adapter resets the
button after receiving the request. Check `lan.diagnostics.result` for
the outcome. `pending` means a drink request is still in progress.
`sent` means the command was sent to the machine. Confirm the drink or power
action at the machine.

Use drink buttons while at the machine with the drinks menu ready and a cup
in place. Attach the milk carafe for milk drinks. The machine may return a
cached ready report, so check the display before pressing a drink button.

Open **Controls → Profiles** and choose a profile and drink. The adapter uses
the names reported by the machine at startup and keeps the profile slot numbers
in the object IDs. Each button uses its own folder's profile, independently
of the selection on the machine display. Before starting a drink, the adapter
reads that profile's recipe over LAN. If the machine cannot confirm it, the
button reports `recipe-unconfirmed` and skips preparation. The adapter leaves
the saved recipe unchanged. The machine's display handles Coffee Pot and Tea.

On the ECAM612.55, a coffee prepared from a named profile matched the saved
cup size. The adapter now retries interrupted status and recipe reads and
waits for the machine to collect a queued request. The retry tests are
automated. Starting a drink on the first press after wake or a LAN
reconnect still needs confirmation on hardware. The same applies to
the additional drink recipes and the stop command.

Wake from reachable standby and switch-off were checked on the ECAM612.55.
Once the Wi-Fi module goes offline, turn the machine on at its display.

| Setting | Accepted values |
| --- | --- |
| `autoOff` | `0` 15 min, `1` 30 min, `2` 1 h, `3` 3 h |
| `waterHardness` | `0` through `3` for the display's levels 1 through 4 |

Use `lan.diagnostics.readSettings` to load the current settings. Writes are
acknowledged after the machine returns a matching value. Results are shown
in `autoOffResult` and `waterHardnessResult`. The diagnostics branch also
offers `readStatus` and `readStatistics`.

### Upgrading from development versions

The new LAN switch replaces the three development switches. Existing active
LAN settings still work until you save a new choice. Existing read-only LAN
settings keep controls disabled until you explicitly enable the new switch.
Enter the machine's address before saving if the field is blank.

Update scripts and dashboards that use the old **Drinks** or **Automation**
paths. A drink button now lives under its profile, for example
`lan.control.profiles.profile1.cappuccino` for profile 1. Use
`info.lan.status` and `info.lan.lastAuthenticatedAt` for LAN diagnostics.

### Reporting a problem

Include the adapter version and machine model. For LAN issues, copy the exact
values of `info.lan.status` and `info.lan.lastAuthenticatedAt` from the instance.
`registered` means the machine accepted the callback address, `encrypted` means
keys were exchanged, and `verified` means authenticated data arrived. If you see
`register-http-<code>` or another error, include the full status.

For a missed drink command, add the profile slot, `lan.diagnostics.result` and
whether the machine had just woken up or reconnected. Keep account details,
machine serial numbers and LAN keys out of public reports.

## Development

Node.js 22.19 or later is required.

```sh
npm ci
npm run lint
npm run check
npm run test:package
npm run test:integration
```

This adapter runs plain JavaScript and JSON configuration directly; no compilation
or frontend build is required.

For future releases, add a `### **WORK IN PROGRESS**` changelog section with the
actual changes, commit them, and use `npm run release patch`. The release tooling updates
package versions and release notes together. Version tags trigger the test matrix
and, after it passes, the official ioBroker deploy action. npm Trusted Publishing
requires a publisher configured for GitHub user `chrvidal`, repository
`ioBroker.coffeelink`, workflow `test-and-release.yml` (no environment). The first
npm version must be published interactively before configuring that publisher.

The LAN implementation uses the
[PrimaDonna Soul protocol notes](https://github.com/Styx85/cremaevolution-ha/blob/main/docs/ecam-lan-protocol.md)
and [aioecam's statistics references](https://github.com/Styx85/aioecam/blob/60c980f4584ec4085c185977d74f986ea7f08c41/src/aioecam/ecam/statistics.py).

## Changelog

Older releases are documented in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

<!--
Unindent this heading when adding changes for the next release:
    ### **WORK IN PROGRESS**
-->

### 0.2.6

- Use Intel macOS runners for all supported Node.js versions during arm64 runner capacity constraints.
- Keep update metadata limited to npm releases and use the token-free Trusted Publishing path.

### 0.2.5 (GitHub CI candidate; not published to npm)

- Remove GitHub-only preview versions from the ioBroker update metadata.
- Keep their development history in this README and CHANGELOG_OLD.md.

### 0.2.4

- Add shared ioBroker lint checks, updated test tools and dependency updates.
- Enable tag-triggered npm Trusted Publishing and GitHub releases after successful tests.
- Support a manually published first version without attempting to publish it twice.
- Add consistent release tooling and retain older release notes separately.
- Categorize the adapter under household devices.

### 0.2.3

- Retry undelivered LAN writes for auto-off delay and water hardness.
- Read the setting back if its acknowledgement is missing or the LAN session changes.

### 0.2.2

- Move unanswered or incomplete automatic LAN statistics reads to the debug log.
- Include ioBroker integration test diagnostics in Windows CI logs.

### 0.2.1

- Restore the PrimaDonna Soul LAN connection after a network or power outage.
- Check for a response before replacing an idle LAN session.
- Report unsupported LAN models and document what to include in a LAN bug report.

### 0.2.0

- Discover named machine profiles and give each profile its own drink buttons.
- Read the saved recipe over LAN for every drink, including Coffee and Espresso.
- Retry the notification for an uncollected LAN request and recover from a
  session change during recipe preparation.
- Report pending drink requests and ignore repeat presses while a request is active.
- Remove the old Drinks folder and the default drink-profile setting.

## License

MIT

Copyright (c) 2026 chrvidal <christian_vidal@icloud.com>

[License text](LICENSE)
