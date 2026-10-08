# Private probes

A private probe is our probe program running inside your network. It checks what our regions can't reach (internal services, databases, staging environments) and reports the results to us. It only makes outgoing HTTPS requests; nothing has to be opened to the internet.

Private probes are part of the Pro plan (one) and the Business plan (five); more can be added to a plan.

## Add one

1. **Settings → Private probes → Add private probe.** Give it a name that says where it runs.
2. Copy the install command and run it on a machine with Docker that can reach both your internal services and us:

   ```sh
   docker run -d --name monitoring-probe --restart unless-stopped \
     --cap-drop ALL --cap-add NET_RAW \
     -v monitoring-probe:/var/lib/watchpost-probe \
     -e API_URL=https://YOUR-HOST -e PROBE_TOKEN=wpp_... \
     ghcr.io/hassamalidev/watchpost-probe:latest
   ```

   The command holds the probe's token and is shown once. `NET_RAW` is for ping checks; leave it out if you don't use them. The volume keeps results the probe couldn't send (up to 10 minutes) across a restart.

3. Within a minute the probe shows as **Online** in Settings.
4. On a monitor, choose **Check from → Private probe: <name>**. That monitor then runs on the probe and nowhere else.

## How it behaves

- A private probe is a check location of its own, named `private:<probe ID>`. A monitor runs either from our regions or on one private probe, never both: what the probe can reach, our regions usually can't, and mixing them would report it as down.
- With one location there is no second region to confirm a failure, so a monitor on a private probe goes down after two failed checks in a row.
- The probe may reach private addresses (10.x, 192.168.x, …), which our own probes refuse. It never checks our own API host.
- **Offline:** a probe that hasn't reported for five minutes shows as offline, and the workspace's owners and admins get one email. Its monitors aren't checked and don't alert while it is offline; they don't count as down. When the probe reports again and later goes silent again, that is a new email.
- **Upgrades:** the list says when a newer probe program is out. Run `docker pull` on the image and start the container again with the same command; the token stays the same.
- **Removing** a probe makes its token stop working at once. A probe that still has monitors can't be removed: move or delete them first.
- The token is the probe's signing key. Anyone who has it can report results for the monitors on that probe, so treat it like a password. If it leaks, remove the probe and add a new one.

## Service checks

Three monitor types exist only on private probes, because the services they check live inside a network. They are offered in the monitor form once the workspace has a private probe, and each needs the host, the port and whether to use TLS. A password is stored encrypted and never shown again; the probe gets it, because it has to log in.

| Type                                                                   | What "up" means                                                                                                                      | Settings                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| **Redis** (also Valkey, KeyDB, Dragonfly)                              | The server answers `PING` with `PONG`, after `AUTH` when a password is set                                                           | port (6379), TLS, username, password            |
| **MQTT broker** (3.1.1: Mosquitto, EMQX, HiveMQ, RabbitMQ's plugin, …) | The broker accepts a connection (`CONNACK` 0), with the login when set; the probe disconnects cleanly                                | port (1883), TLS, username, password, client ID |
| **gRPC health**                                                        | The server's standard health service (`grpc.health.v1.Health/Check`) answers `SERVING` for the whole server or for the named service | port, TLS (on by default), service name         |

What goes wrong is told apart: a refused login (`auth_failed`), something on the port that isn't that kind of service (`protocol_error`), a gRPC service that says it is not serving or doesn't exist (`service_unhealthy`), and the usual connection and TLS failures. The probe never runs a command beyond the handshake, so a monitoring account with the least rights is enough (Redis: an ACL user with only `+ping`; MQTT: a user that may connect and nothing else).

Not built yet (P6-T08b): Docker containers, databases (Postgres, MySQL, MSSQL, MongoDB), Kafka, RabbitMQ (AMQP), SNMP, RADIUS, game servers and a per-monitor proxy. A TCP port check works for any of them in the meantime, and the integration request log says which to build first.

## Requirements

- Docker on Linux (amd64 or arm64), about 300 MB of memory.
- Outgoing HTTPS to the app's address. No incoming ports.
- A clock within a few minutes of real time (requests are signed with the time).

## For operators of the service

- The image name in the install command is `PRIVATE_PROBE_IMAGE`. Pushing a tag `probe-v<version>` builds and publishes it (`.github/workflows/probe-image.yml`); the package has to be public for customers to pull it.
- `PROBE_CURRENT_VERSION` in `packages/shared/src/schemas/region.ts` is the version probes are compared with for the upgrade notice. Raise it together with `PROBE_VERSION` in `probe/src/runtime.ts` when releasing.
- Code: `backend/src/modules/probes/private.ts`; the probe reads `PROBE_TOKEN` in `probe/src/config.ts`.
