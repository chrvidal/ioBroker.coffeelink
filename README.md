# ioBroker.coffeelink

Independent, **read-only** ioBroker adapter for Wi-Fi machines supported by
De'Longhi's **Coffee Link** app.

**Author/Maintainer:** [chrvidal](https://github.com/chrvidal). This is a new
project, not a fork of or dependency on any other ioBroker De'Longhi adapter.

## Status

**Early development version 0.0.14: NOT released on npm. Do not install in your
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


## Experimental local LAN reader (v0.0.4)

By default the adapter remains cloud-only or passive. The additional **LAN active** checkbox opts in to one `POST /local_reg.json?dsn=...` to your own machine, which changes where it sends local status updates. **This may disrupt the official Coffee Link app's local connection.** Switching back to passive does not necessarily restore the previous callback destination; restarting or reconnecting the official app may be necessary. Use this mode only when you accept that risk.

* Requires passive receiver enabled, a specific LAN bind IP (e.g. the ioBroker host IP, never `0.0.0.0`), port 10275 and correct machine IP.
* Obtains the LAN authentication secret from the user's own authenticated Ayla account; never logs or writes it to ioBroker states.
* Exchanges local session keys and signs/encrypts commands; only issues `GET property.json` to read properties, **never** makes drinks, power changes or settings changes.
* Stores any locally received counters under `machines.<id>.lan.counters.*`, separate from cloud counters until checked against the machine display.
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
## LAN key-ID diagnostics and retry (v0.0.14)

LAN registration now retries on the next normal cloud refresh after a transient network error. The active LAN health endpoint reports numeric `cloudKeyId`, `machineKeyId`, and `keyIdsMatch` to detect a stale or wrong LAN key **without exposing key material**. Key-exchange framing matches the hardware-tested aioecam reference (HTTP 202, 13-digit millisecond `time_2`, untouched `random_1`) while keeping explicit Content-Length. Registration sends `notify: 1`. This opt-in LAN feature remains experimental; real-device datapoint reception with ECAM612 has NOT been confirmed. Registering locally may interrupt the official Coffee Link application.
