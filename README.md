# OpenKNX XML Navigator

Browser-based navigator for expanded OpenKNX / KNX debug XML files.

## What it does

- Loads server-backed XML sources from `examples/` and `data/`
- Loads any local XML file through the browser file picker
- Resets to the bundled example with `Load default`
- Renders channels, pages, parameters, communication objects, help texts, and icons
- Uses `examples/LedDimmerAB.debug.xml` as the bundled default example

## Repository layout

- `examples/`: bundled example XML and matching baggage archives
- `data/`: optional mounted XML sources for Docker or NAS deployments
- `deploy/truenas-compose.yaml`: compose example for a TrueNAS custom app

For help texts and navigation icons, keep the matching `.baggages` folder next to the XML source. Browser-uploaded XML files work without baggage, but help texts and icons stay unavailable unless the same XML is also present as a server source.

## Local run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

## Environment variables

- `OPENKNX_XML_NAVIGATOR_PORT`: HTTP port. Default: `4173`
- `OPENKNX_XML_NAVIGATOR_SOURCE_DIRS`: semicolon-separated source directories relative to the repo root. Default: `examples;data`
- `OPENKNX_XML_NAVIGATOR_DEFAULT_SOURCE`: default XML source relative to the repo root. Default: `examples/LedDimmerAB.debug.xml`

## Docker build

```powershell
docker build -t openknx-xml-navigator .
```

## Docker run

```powershell
docker run --rm -p 4173:4173 -v ${PWD}/data:/app/data openknx-xml-navigator
```

Put additional XML files into `data/`. The bundled example remains available and `Load default` returns to it at any time.

## Docker Compose

```powershell
docker compose up --build -d
```

The included `docker-compose.yml` builds the image locally, publishes port `4173`, and mounts `./data` into the container.

## Deployment

Use `deploy/deploy-compose.yaml` as the starting point for a custom app.

The included example is YAML-only:

- it builds directly from `https://github.com/kikakeule/OpenKNX-XML-Navigator.git#main:.`
- it does not require a local checkout on the NAS
- it does not require a prebuilt image
- it starts with the bundled `examples/LedDimmerAB.debug.xml`

This is enough if you mainly want the bundled example plus the browser file picker for ad-hoc XML files.

If you want additional server-backed XML files, add a host path mount to `/app/data`, for example:

```yaml
		volumes:
			- /mnt/tank/apps/OpenKNX-XML-Navigator/data:/app/data
```

If your Docker release rejects remote Git build contexts, the fallback is the local-path approach from `docker-compose.yml`: clone the repository onto the NAS and use that path as the build context.

