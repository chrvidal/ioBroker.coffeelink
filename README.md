# ioBroker.coffeelink

Independent, **read-only** ioBroker adapter for Wi-Fi machines supported by
De'Longhi's **Coffee Link** app.

**Author/Maintainer:** [chrvidal](https://github.com/chrvidal). This is a new
project, not a fork of or dependency on any other ioBroker De'Longhi adapter.

## Status

**Early development version 0.0.1: NOT released on npm. Do not install in your
production ioBroker system.**

Cloud read access was verified manually with a **PrimaDonna Soul ECAM612.55**:
312 properties and 22 candidate values. Four apparent water/hardness/descale fields are intentionally not mapped yet due
to unclear semantics or suspicious results.

Current implementation:

- Coffee Link (Gigya) + Ayla EU cloud authentication;
- list up to five connected coffee machines;
- read 18 identified beverage/maintenance counters;
- expose machine cloud reachability separately from its last known state;
- parse `d302_monitor` status packets, including CRC validation;
- mark old monitor data **stale** rather than claiming the machine is currently ready;
- poll every 15 minutes by default, configurable 5–1440 minutes;
- protect configured password using ioBroker encryptedNative and protectedNative;
- NO brew requests, NO standby/wake commands, NO changes to the device.

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
