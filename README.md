# OpenKNX-XML-Navigator

Browser-based navigator for expanded OpenKNX / KNX debug XML files.
KNX is a trademark of KNX Association. OpenKNX is an independent project and this tool is not affiliated with KNX Association.

## What it does

- Loads server-backed XML sources from `examples/` and `data/`
- Loads local XML, ZIP, and KNXPROD files through the browser file picker
- Resolves help texts and navigation icons from ZIP / KNXPROD baggage when available
- Prompts for product and language selection when a KNXPROD package contains multiple choices
- Resets to the bundled example with `Load default`
- Renders channels, pages, parameters, communication objects, help texts, and icons
- Can open a supported remote XML, ZIP, or KNXPROD directly from the page URL
- Uses `examples/LedDimmerAB.debug.xml` as the bundled default example

## Repository layout

- `examples/`: bundled example XML and matching baggage archives
- `data/`: optional mounted XML sources for Docker or NAS deployments
- `deploy/deploy-compose.yaml`: generic compose example for NAS or Docker custom-app deployments

For help texts and navigation icons, keep the matching `.baggages` folder next to the XML source. Browser-uploaded plain XML files work without baggage, but help texts and icons stay unavailable unless the same XML is also present as a server source. ZIP and KNXPROD uploads can bring their own baggage archives and icons.

## Local run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

## Usage modes

### 1. Server-backed sources

Use the source dropdown for XML files from `examples/` or `data/`.

- Best choice for repeatable local testing
- Supports help texts and icons from matching `.baggages` folders
- `Load default` returns to `examples/LedDimmerAB.debug.xml`

### 2. Local file picker

Use the browser picker for ad-hoc imports.

- `.xml`: loads the XML only
- `.zip`: loads the first matching XML plus embedded help/icon baggage
- `.knxprod`: loads a KNXPROD package and reuses embedded application XML, help, and icons when present

For KNXPROD packages the navigator opens a selection dialog when needed:

- product selection for multi-product packages
- language selection when translations are available

### 3. Direct page call with a remote source

The page can start directly with a remote XML, ZIP, or KNXPROD URL. The server downloads the file first and then opens the same import flow used by the local picker.

Supported query parameters:

- `knxprod`
- `sourceUrl`
- `source`
- `url`

Example:

```text
http://localhost:4173/?knxprod=https%3A%2F%2Fwww.mdt.de%2Ffileadmin%2Fuser_upload%2Fuser_upload%2Fdownload%2FMDT_KP_SCN_01_Weather_Station_V13a.knxprod
```

Notes:

- URL-encode the remote file URL in the query string
- the server follows redirects and supports `http` and `https`
- KNXPROD imports still show the product/language selector when required
- the imported source is session-local and is not added to the server-backed source list

## Environment variables

- `OPENKNX_XML_NAVIGATOR_PORT`: HTTP port. Default: `4173`
- `OPENKNX_XML_NAVIGATOR_SOURCE_DIRS`: semicolon-separated source directories relative to the repo root. Default: `examples;data`
- `OPENKNX_XML_NAVIGATOR_DEFAULT_SOURCE`: default XML source relative to the repo root. Default: `examples/LedDimmerAB.debug.xml`
- `OPENKNX_XML_NAVIGATOR_APP_TITLE`: UI title. Default: `OpenKNX-XML-Navigator`
- `OPENKNX_XML_NAVIGATOR_APP_SUBTITLE`: subtitle below the title
- `OPENKNX_XML_NAVIGATOR_TRADEMARK_NOTICE`: text shown in the About dialog for trademark / project attribution
- `OPENKNX_XML_NAVIGATOR_REPOSITORY_URL`: About dialog repository link
- `OPENKNX_XML_NAVIGATOR_REPOSITORY_LABEL`: About dialog repository link text

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

## Public hosting note

If you expose the navigator outside a private local setup, trademark attribution alone is usually not enough. Depending on jurisdiction and audience, you may also need operator-specific legal information such as an Impressum, provider identification, privacy notice, or contact details.

This project does not generate a built-in legal notice page or Impressum for you. If your deployment requires one, provide it separately as part of the hosting environment or a linked external page.

## Deployment

Use `deploy/deploy-compose.yaml` as the starting point for a generic custom-app deployment.

The included example is YAML-only:

- it builds directly from `https://github.com/kikakeule/OpenKNX-XML-Navigator.git#main:.`
- it omits `image:` and lets Docker build straight from Git
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

