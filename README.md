# ioBroker.coffeelink

Independent, **read-only** ioBroker adapter for Wi-Fi machines supported by
De'Longhi's **Coffee Link** app.

**Author/Maintainer:** [chrvidal](https://github.com/chrvidal). This is a new
project, not a fork of or dependency on any other ioBroker De'Longhi adapter.

## Status

**Early development version 0.0.3: NOT released on npm. Do not install in your
production ioBroker system.**

Cloud read access was verified manually with a **PrimaDonna Soul ECAM612.55**:
312 properties and 22 candidate values. Four apparent water/hardness/descale fields are intentionally not mapped yet due
to unclear semantics or suspicious results.

Current implementation:

- Coffee Link (Gigya) + Ayla EU cloud authentication;
- list up to five connected coffee machines;
- read 18 identified beverage/maintenance counters;
- expose the De'Longhi cloud last-change times for only-coffee and coffee-with-milk totals under `machines.*.diagnostics`;
- expose machine cloud reachability separately from its last known state;
- parse `d302_monitor` status packets, including CRC validation;
- mark old monitor data **stale** rather than claiming the machine is currently ready;
- poll every 15 minutes by default, configurable 5–1440 minutes;
- protect configured password using ioBroker encryptedNative and protectedNative;
- NO brew requests, NO standby/wake commands, NO changes to the device.

## Compare with statistics on the machine

The ECAM612.55 machine screen can report different totals from Ayla cloud values.
Do not assume that `info.connection = true` means the counters are up to date.
`machines.*.diagnostics.blackCoffeeCloudUpdatedAt` and
`machines.*.diagnostics.milkCoffeeCloudUpdatedAt` show the last time the
cloud **changed those two values**, in UTC; they do not measure last polling.
If these dates are recent and counts disagree, counting rules may differ.
Avoid guessed offsets until confirmed by controlled real-machine measurements.

## Experimental passive LAN receiver (v0.0.3)

A separate, **disabled-by-default** listener is available for verifying that
ioBroker can bind its LAN callback port. It is not yet a functional LAN
connection: **no local registration is attempted**. The machine will not send
callbacks to ioBroker until a future explicit registration step.

- `lanReceiverEnabled`: false by default.
- `lanListenAddress`: `127.0.0.1` (local-only test) by default; set a LAN IP
  only after explicitly deciding to test the network callback receiver.
- `lanListenPort`: 10275 (configurable).
- `lanMachineIp`: optional expected IPv4 address for future callback diagnostics.
- `info.lanListener` shows whether the port was actually opened.
- `info.lanLastContact` is a timestamp only, not an authenticated machine status.
- All machine callbacks are refused (HTTP 503) until a separately tested
  authenticated encrypted LAN session is implemented.
- No HTTP requests are sent **to the machine** in passive mode. Cloud reads
  remain unchanged.

This prevents taking over the registration held by the official Coffee Link app.
Do not mistake a listening port for a working LAN integration.

## Planned

- Developer-server integration test with mock Cloud responses.
- Validate devices and counters on other machines.
- Inspect water and hardness properties before publishing them.
- Add integration tests, icon and broader internationalization coverage.
- Support ioBroker's central credentials store once its API is integrated/tested.
- Publishing only after real instance testing and adapter-checker success.

## Developer checks

Requires Node.js 20+. From the project directory:

```sh
npm test
node --check main.js
```

The tests use mock API responses; they never call De'Longhi.

## Privacy and safety

The adapter sends account login details only to the Coffee Link authentication
service over HTTPS. API tokens stay in memory. No credentials, cloud responses,
or serial numbers are written to logs. Device IDs in the ioBroker tree are
short, deterministic hashes of the cloud device identifiers.

This is an **unofficial API**. The endpoints and application identifiers may
change, and Cloud values can be old even while a machine reports Online.

## Protocol research

This is an original implementation of public reverse-engineered Coffee Link
protocol findings. Background information includes:

- https://github.com/actabi/delonghi_coffeelink
- https://github.com/sk7n4k3d/delonghi-ha

No code files or adapter architecture were copied from other ioBroker projects.
