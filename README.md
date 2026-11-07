# ioBroker.coffeelink

Independent ioBroker adapter for Wi-Fi machines supported by De'Longhi's
**Coffee Link** app. Cloud access is read-only. ECAM61x machines can opt in to
experimental local controls.

[De'Longhi](https://www.delonghi.com/)

**Author/Maintainer:** [chrvidal](https://github.com/chrvidal). This is a new
project, not a fork of or dependency on any other ioBroker De'Longhi adapter.

## Status

**Early development version 0.0.15: NOT released on npm. Do not install in your
production ioBroker system.**

Cloud read access was verified manually with a **PrimaDonna Soul ECAM612.55**:
312 properties and 22 candidate values. Four apparent water/hardness/descale fields are intentionally not mapped yet due
to unclear semantics or suspicious results.

Current implementation:

- Coffee Link (Gigya) + Ayla EU cloud authentication;
- list up to five connected coffee machines;
- read 18 identified beverage/maintenance counters;
- expose the De'Longhi cloud last-change times for only-coffee and coffee-with-milk totals under `machines.*.cloud.diagnostics`;
- expose machine cloud reachability separately from its last known state;
- parse `d302_monitor` status packets, including CRC validation;
- mark old monitor data **stale** rather than claiming the machine is currently ready;
- poll every 15 minutes by default, configurable 5–1440 minutes;
- protect configured password using ioBroker encryptedNative and protectedNative;
- optional local controls for ECAM61x machines.

## Compare with statistics on the machine

The ECAM612.55 machine screen can report different totals from Ayla cloud values.
Do not assume that `info.connection = true` means the counters are up to date.
`machines.*.cloud.diagnostics.blackCoffeeCloudUpdatedAt` and
`machines.*.cloud.diagnostics.milkCoffeeCloudUpdatedAt` show the last time the
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

Requires Node.js 22.19+. From the project directory:

```sh
npm ci
npm run check
npm run test:package
npm run test:integration
```

The unit tests use mock API responses. The integration test installs and
starts the adapter in a temporary ioBroker controller with its default
configuration and blank credentials.

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


## Experimental local LAN reader (v0.0.4)

By default the adapter remains cloud-only or passive. The additional **LAN active** checkbox opts in to one `POST /local_reg.json?dsn=...` to your own machine, which changes where it sends local status updates. **This may disrupt the official Coffee Link app's local connection.** Switching back to passive does not necessarily restore the previous callback destination; restarting or reconnecting the official app may be necessary. Use this mode only when you accept that risk.

* Requires passive receiver enabled, a specific LAN bind IP (e.g. the ioBroker host IP, never `0.0.0.0`), port 10275 and correct machine IP.
* Obtains the LAN authentication secret from the user's own authenticated Ayla account; never logs or writes it to ioBroker states.
* Exchanges local session keys and signs and encrypts LAN messages. Device controls require the separate ECAM61x opt-in described below.
* Stores counters from the Soul's direct A2 reads under `machines.<id>.lan.statistics.*`. Other devices can expose named LAN properties under `lan.counters`.
* Status state `info.lanStatus`: `disabled`, `registered`, `encrypted`, `no-lan-key`, `register-failed`, `connection-failed`.
* The LAN integration is experimental and not confirmed with a live machine. Cloud mode remains functional independently.


## LAN registration diagnostic (v0.0.5)

Version 0.0.5 exposes the **HTTP status code** or a coarse network failure
category for an attempted local `PUT /local_reg.json`. The code is shown in
`coffeelink.0.info.lanStatus`, such as `register-http-404`, `register-http-403`,
`register-timeout`, or `register-connection-refused`. No response bodies,
account secrets, or LAN keys are logged or put into states. A `404` from
`GET /local_reg.json` is **not** sufficient to diagnose the supported `PUT`.

This diagnostic does not add any requests or enable active LAN by default.
The opt-in registration still changes the device's local callback target
if accepted, which may affect the official Coffee Link app.


## Tested registration correction (v0.0.6)

On a real PrimaDonna Soul ECAM612.55 on November 7, 2026, `PUT /local_reg.json`
returned HTTP 400. An explicit manual `POST /local_reg.json?dsn=<device identifier>`
with `notify: 0` returned **HTTP 202 Accepted**. v0.0.6 changes only the
**opt-in** active LAN registration call to POST with the DSN query parameter,
with `notify: 1` to request actual callbacks. The latter is not yet verified
on this physical machine; HTTP 202 would confirm acceptance, **not** that the
encrypted handshake or counter retrieval works. The native state
`info.lanStatus` distinguishes `registered` from `encrypted`.

**Caution:** Updating or restarting the adapter with the persisted active-LAN
checkbox enabled can immediately send a new registration. First disable the
active-LAN checkbox in the installed instance and save before updating. Keep
passive LAN receiver enabled, bind to the ioBroker LAN IP, and make active
registration a deliberate test after installation. The registration may affect
the official Coffee Link app's local connection. Avoid repeated retries.


## LAN registration correction (v0.0.7)

The real ECAM612.55 accepted `POST /local_reg.json?dsn=...` with
`notify: 0` (HTTP 202), but rejected the same call with `notify: 1`
(HTTP 400). Version 0.0.7 changes the **opt-in active** request to
`notify: 0`. An independent Ayla capture on another device confirms
that `notify: 0` can still initiate a device-to-server encrypted key
exchange; the ECAM612 handshake and fresh counters are **not yet verified**.

This is not a change in brewing or settings. But LAN registration may
change the active local callback target, disrupting the official app.
Before installing this release, turn off and save the **active LAN** checkbox
in the installed instance. After installing, the user must explicitly
turn it on again to attempt the LAN handshake. Do not automatically retry.

Do not interpret `registered` as `encrypted`, or cloud `online` as fresh data.
The local counters stay in the experimental `machines.*.lan.counters.*`.

## LAN registration transport fix (v0.0.8)

On the tested ECAM612.55, `curl` and Node `http.request` with explicit
HTTP/1.1 headers returned **202 Accepted**, while Node `fetch` returned
**400 Bad Request** for the same JSON registration payload.
The opt-in `POST /local_reg.json?dsn=...` registration now uses the
built-in `node:http` module with the exact working headers and an explicit
Content-Length (no `fetch`/undici). It only returns a numeric HTTP status,
does not follow redirects, and does not log response bodies or credentials.

**LAN registration remains experimental and explicitly opt-in.** A 202 confirms
only acceptance of the registration request; encrypted callbacks and fresh
local drink counters still require validation on the real machine. Disable
active mode and save before upgrading a running ioBroker installation to
avoid accidental registrations during restart.

## LAN receiver improvements (v0.0.9)

This is an EXPERIMENTAL, opt-in read-only local integration, not a confirmed source
of current beverage counters. Local key exchange only proves that the device
and adapter exchanged session parameters, not that application data decrypted.

- Accepts callback URLs containing `?cmd_id=...&status=...` rather than 404ing.
- Recognizes bulk property lists and individual `data.name`/`data.value` updates.
- Responds HTTP 200 to encrypted data packet decoding errors (no payload logs)
  to avoid triggering device backoff.
- `GET /health` exposes only safe counters and timestamps: `pollCount`,
  `pushCount`, `decodedCount`, `propertiesCount`, `lastError`.
- If the device exchanges keys but never polls commands, an ACTIVE client
  makes at most ONE additional registration reminder after 25 seconds.
  This can affect the official Coffee Link app. Disable active mode if needed.
- No coffee brewing, power, or settings commands are sent. Actual property
  retrieval is read-only. Local counters remain separate from cloud values.
## LAN crypto correction (v0.0.10)

Ayla's documented LAN protocol uses AES-256-CBC: the derived encryption keys
must be **32 bytes**, not the 16-byte keys previously used by this adapter.
IVs remain 16 bytes. The independent LAN protocol code has been corrected,
with regression tests using the full derived keys.

The opt-in LAN listener now exposes non-secret handshake fingerprints in
`GET /health` (time_1 digit count, presence of ver/proto/key_id fields,
and number of key-exchange replies handed to the socket), plus a count of
requests from the machine. No raw nonces, local keys, identifiers, callback
bodies or datapoint values are included.

**Important:** The real device currently exchanged keys twice but never polled
for commands or pushed a property. The AES correction is necessary but does
not prove this separate communication failure is fixed. No change to the
handshake HTTP status or machine registration format is made without evidence.
Active LAN registration may disrupt the official Coffee Link app; keep it
explicitly opt-in and disable/save before upgrading an installed instance.
## LAN v1 handshake fix (v0.0.11)

Real ECAM612.55 diagnostics: ver:1/proto:1/key_id present, 15-digit time_1,
registration accepted, repeated key exchanges, but no subsequent command polls.
The adapter's handshake used HTTP 202 and a 13-digit millisecond time_2.
An independent Ayla v1 packet trace documents HTTP 200 with a 16-digit
microsecond time_2, followed by a command poll. This release matches that
response and includes a regression test for the observed firmware pattern.

This is an evidence-based interoperability correction, NOT proof that this
specific coffee machine is fully supported. Encryption still uses AES-256,
registration remains active-mode opt-in, and no brew/settings writes occur.
Disable and save active LAN before updating an installed adapter; deliberately
re-enable afterward. Re-registration may affect the official Coffee Link app.
## LAN response framing fix (v0.0.12)

The real ECAM612.55 reaches the local server, receives an HTTP 200
handshake reply with 16-digit time_2, but never polls commands or pushes
datapoints. Comparison with an ESP32 Ayla v1 wire trace revealed that
its reply uses an explicit Content-Length while the Node.js server sent
Transfer-Encoding: chunked by default. Embedded HTTP clients can fail
on chunked JSON responses. All LAN JSON responses now send an explicit
byte-accurate Content-Length with no chunked transfer encoding.

This fixes a verified HTTP framing difference, but live machine behavior
remains to be checked. The LAN integration is experimental, read-only,
and active registration is opt-in and can affect the official mobile app.
## LAN ESP32 command response framing (v0.0.13)

Version 0.0.12 reached a real ESP32/Ayla v1 command poll (`pollCount=1`)
with the ECAM612.55, but no machine datapoints were returned. An
independent real Ayla ESP32 packet capture shows the command-poll HTTP
reply has exactly two JSON fields: `enc` and `sign`. Our reply also
included an unnecessary top-level `seq`. Version 0.0.13 removes that
extra field while preserving `seq_no` inside the encrypted request.

Safe health diagnostics now include `commandRepliesSent` (HTTP response
handed to socket, NOT machine acceptance), `lastCommandKind` and
`lastPollResponseBytes`. No key, raw ciphertext or account information
is logged. LAN mode is experimental, read-only, opt-in; a registration
can affect the official Coffee Link app. Real-device verification pending.
## LAN counter reads (local v0.0.14 candidate)

Live v0.0.13 diagnostics on the ECAM612.55 recorded three decoded pushes and
one named property. ioBroker had a LAN contact timestamp and no LAN counter
states. The candidate preserves the v0.0.13 handshake and fixed Content-Length.
It requests each known counter by name, following the single-property GET
format used by [aioecam](https://github.com/Styx85/aioecam/blob/60c980f4584ec4085c185977d74f986ea7f08c41/src/aioecam/lan/messages.py).
A verified session can request another poll through `PUT /local_reg.json`.
Registration retries transient network failures after short delays of 3 and
12 seconds, then at the normal refresh interval. Each start allows up to five
attempts.

The local `/health` endpoint distinguishes derived keys (`connected`), an
authenticated callback (`sessionVerified`), decoded packets (`decodedCount`)
and usable counter values (`counterCount`). A known key ID mismatch aborts
the exchange. Diagnostics contain counts, key IDs and status codes.
Run `npm run check` to verify the Python-generated CBC and HMAC vectors and
simulated HTTP callbacks. For a hardware test, check `/health` after startup
and again after the configured refresh interval. Look for increases in
`pushCount`, `decodedCount` and `counterCount`, and check the corresponding
states under `machines.<id>.lan.counters.*`.

In the first ECAM612.55 live cycle on November 7, 2026, both key IDs matched.
The machine returned 18 authenticated counter values. The scheduled cycle
15 minutes later returned all 18 again on the same session, with zero
signature errors across both cycles. The LAN coffee count was 9,753 and
the stored cloud count was 9,605. The machine display was unavailable for
comparison.

## Experimental ECAM61x controls and display statistics

Enable active LAN and **ECAM61x LAN controls** in the instance settings to
expose `machines.<id>.lan.control`. Set a button to `true` with `ack: false`.
The buttons provide switch-off, wake from reachable standby, coffee, espresso
and stop. On the ECAM612.55 the `off` state switches the machine off. Wake
requires the machine's LAN module to respond. Coffee and espresso use the
ECAM61x presets and require a fresh ready and idle monitor reply.
`control.readStatus` checks readiness and reports the result without starting
a drink. Button values reset to `false` after the adapter receives the request.
If the machine serves an old monitor despite showing its ready drink menu,
use `coffeeAtMachine` or `espressoAtMachine` while at the machine with a cup in
place. These explicit manual buttons accept a cached ready and idle report.
Use `coffee` and `espresso` for commands that require current readiness.

`autoOff` accepts 0 (15 min), 1 (30 min), 2 (1 h) and 3 (3 h).
`waterHardness` accepts 0 through 3 for display levels 1 through 4. Successful
setting changes are acknowledged after a matching readback. `control.readSettings`
reads the current values. `autoOffResult` and `waterHardnessResult` report
`pending`, `confirmed` or the verification error. The adapter sends a setting
write once and reads it back up to three times. If verification fails, the
input shows the last returned value or an empty value. `control.result`
reports delivery or failure. `sent` means the poll response was sent to the
machine, and `confirmed` means a setting was read back.

Cloud status and counters are under `machines.<id>.cloud`. `info.cloud.connected`
reports the last API sync. The `machines.<id>.lan` branch contains locally read
values and controls. `info.lan.status` shows the LAN session status and
`info.lan.lastAuthenticatedAt` records the last authenticated property. Both
transports can be active at the same time. Upgrades move the previous Cloud
states under `cloud` and remove the old paths directly under the machine ID.

Cloud beverage control is a separate future feature. Model-specific delivery
and confirmation need hardware testing before exposing Cloud controls.

The direct A2 statistics are read separately under `lan.statistics`.
On the ECAM61x these are the single LAN counter source, including drink types.
The older `lan.counters` branch contained values retained by the WLAN module
and is removed after direct statistics have been verified for the machine.
On the tested ECAM612.55, the module returned 10,009 black coffees while A2
returned 10,077. A2 also returned 9,820 coffees and 127 espressos, and a manual
repeat after a new key exchange confirmed all seven statistics pages.
`control.readStatistics` requests them on demand. If the machine keeps the
reply in its LAN module, the adapter reads `data_response` to retrieve it. The
ECAM612.55 returned 10,075 black coffees, 2,862.0505 litres, 39 descalings,
661 container cleans and 35 filters through A2. Separate A2 reads returned
966 coffees with milk and 6 milk-only beverages, giving `withMilk = 972`,
which matches the machine display. Both the startup and manual reads gave
the same values. If an A2 page is unconfirmed, the adapter updates the pages
it received and reports a partial result. The manual coffee and espresso
buttons prepared both drinks on the ECAM612.55 on November 7, 2026. The
next confirmed A2 read showed the black coffee total increase from 10,075 to
10,076. The switch-off command was verified by the operator. Reading and
writing back the existing settings was verified with a 3-hour auto-off delay
and water hardness level 3. The machine acknowledged both and reported the
same values afterwards. The repeat with the readback retries confirmed both
settings after one request per setting. Wake and drink cancellation await
hardware verification.
See [aioecam's ECAM61x profile](https://github.com/Styx85/aioecam/blob/60c980f4584ec4085c185977d74f986ea7f08c41/src/aioecam/ecam/profiles/ecam61x.json)
and [A2 statistics](https://github.com/Styx85/aioecam/blob/60c980f4584ec4085c185977d74f986ea7f08c41/src/aioecam/ecam/statistics.py).

## Changelog

### 0.0.15

- Read ECAM61x statistics directly over LAN and remove the older LAN counter branch for this family.
- Separate Cloud and LAN states, and add optional LAN controls for supported Soul machines.
- Verify setting writes by readback and retry transient LAN registration failures.
- Add package validation and an ioBroker installation and startup test. Require Node.js 22.19 or newer.

## License

MIT. Copyright © 2026 chrvidal. [License text](LICENSE)
