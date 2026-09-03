# TARANG — Remaining Work

Status snapshot as of the current `main` branch. Every Must-have and
Should-have from the README's MoSCoW list (§13) is done. What's left is
optional stretch work, not required deliverables.

## Done on branch `feature/palette-editor-ogc` (2026-09-03)

- **Customizable colorbar editor** — replaced the four duplicated GLSL palette
  switches + two JS copies with one shared 256px LUT (`frontend/src/scene/colormaps.ts`).
  13 palettes incl. the cmocean oceanography set (thermal/haline/deep/dense/balance/curl/ice),
  grouped dropdown, reverse toggle, live gradient preview. `ColormapConfig.reversed` added.
- **WMS GetFeatureInfo** — `backend/app/wms_wcs/wms.py`, text/html/JSON; layers now
  `queryable="1"`, capabilities advertise the op.
- **OPeNDAP / OGC surfaced** — new `GET /api/ogc/endpoints` directory (per-source
  OPeNDAP/WMS/WCS/NCSS + built-in Option-B URLs), nginx `/opendap/` shortcut,
  "Open-Standards Data Access" section in the Glossary panel.
- **In-browser data upload** — `POST /api/registry/upload` (`backend/app/endpoints/upload.py`)
  takes a NetCDF/CSV, introspects it (vars, bbox, depth levels, time steps, CF attrs),
  writes `registry/<slug>.uploaded.yaml`, hot-reloads. "＋ Add data source" button in
  ControlPanel; new source auto-selected. `data/uploads/` + `*.uploaded.yaml` gitignored.
- **ADCP / mooring profiles** — moorings + ADCP stations were already seeded into
  PostGIS; now `seed_additional_sensors.py` also writes `data/mooring/*.nc` (T/S) and
  `data/adcp/*.nc` (u/v/speed) so clicking those markers opens a real profile.
  `profile.py` reads the new dirs + current columns; ProfilePopover shows a
  current-speed panel and hides empty T/S panels.
- **ML-derived products plugin** — `backend/app/endpoints/derived.py`: `GET /api/derived`
  catalog + `GET /api/derived/water_masses` (unsupervised k-means over standardized
  (T,S), classes ordered surface→deep, per-class centroids). 2D India-map overlay
  ("Water Masses (ML)" layer) with a Leaflet legend. Eddy/front listed in the catalog.
- **Animated current flow** — `frontend/src/scene/flowField.ts` particle-advection
  engine; "Current Flow (animated)" layer on the 2D India map (uo/vo bilinear sample,
  fading trails, pause-on-zoom).
- Tests: +`test_wms_getfeatureinfo` +`test_ogc_endpoints_directory` +`test_registry_upload_netcdf`
  +`test_adcp_mooring_profiles` +`test_derived_water_masses` (pytest **13 passed**).

## Second gap-close pass (2026-09-03, same branch)

- **WMS EPSG:4326 axis order** — `_parse_wms_bbox` swaps to lat,lon for EPSG:4326 (CRS:84
  stays lon,lat). GetMap + GetFeatureInfo both honour it; `test_wms_getfeatureinfo` asserts
  the two CRSs resolve to the same cell.
- **BGC oxygen / nitrate / pH** — `seed_additional_sensors.py` writes them into `bgc_demo.nc`;
  `profile.py` parses them; ProfilePopover now renders a dynamic panel list (T/S + any of
  chl/O2/NO3/pH/current), so new profile variables need no popover change.
- **Time-step prefetch** — `prewarm.ts::prewarmTimeSteps` warms every frame in the background
  when playback starts (backend Redis-caches); interval 500→600 ms.
- **Data export** — WCS `GetCoverage` gained `RANGESUBSET` (WCS 2.0 range-subset) to pick the
  variable; "Download this view (NetCDF)" button in ControlPanel builds the subset URL.
- **ADCP / mooring current vectors** — 2D map draws a surface-current arrow at each ADCP/mooring
  station from its own profile.
- **Globe port** — `WaterMassOverlayLayer` (instanced points) + `FlowLineLayer` (animated
  streamlines with a travelling pulse, `animate()` driven from the render loop) registered in
  SceneManager, gated by the `waterMasses` / `flow` layer toggles.

## "Dropdowns go empty mid-session" bug — ROOT CAUSE + fix (2026-09-03, same branch)

**Cause:** `infra/Dockerfile.backend` ran `uvicorn --reload --reload-dir /app/backend` with
`./backend` bind-mounted. On Docker Desktop the reload watcher fires on phantom bind-mount
FS events (and every code edit) and **restarts the whole app mid-request** → `/api/sources`
fails → Data Source / Variable dropdowns blank until a manual `docker compose restart`.

**Fix — needs `docker compose up -d --build backend`:**
- CMD is now `sh -c "exec uvicorn ... ${UVICORN_RELOAD:+--reload --reload-dir /app/backend}"` —
  **no reload by default**. Set `UVICORN_RELOAD=1` (compose env) for dev hot-reload.
  The registry's polling watcher still hot-loads new YAML manifests without `--reload`.

**ACTUAL ROOT CAUSE (found from logs — container was fine, worker was crashing):**
`_load_from_local_cache` (`profile.py`) and the `/api/eddy` `/api/front` `/api/delta`
compute functions opened NetCDF/HDF5 files and never closed them. Leaked handles → GC
finalizer fault on the shared cached handle → uvicorn **worker crash** → `--reload` respawn
(~30 s) → blank dropdowns. The India-map overlays hammer these endpoints so it recurred.
- Fix: every `adapter.open()` / `xr.open_dataset()` now closed in `finally`
  (`profile.py`, `eddy.py`, `delta.py`).
- `Dockerfile.backend`: `--reload` off by default + `--workers 2` — a worker crash no longer
  causes an outage (sibling serves, uvicorn respawns the dead one). `UVICORN_RELOAD=1` for dev.
- **Requires `docker compose up -d --build`.**

**Defence-in-depth (`backend/app/registry/loader.py`, `metadata.py`, `main.py`, `App.tsx`):**
- `load_all()` builds new maps in locals + atomic swap; a reload yielding 0 manifests while
  some are loaded is discarded as a transient read.
- Watcher debounced (0.8 s); `PollingObserver` by default (`REGISTRY_WATCH_NATIVE=1` to override).
- `registry.ensure_loaded()` called by `/api/sources` + `/api/metadata` — a wiped worker
  self-heals on the next request.
- `main.py` retries the cold-start load up to 5×.
- Frontend: empty `/api/sources` never clobbers a good list; 8 s self-healer re-bootstraps.
- Test: `test_registry_reload_never_wipes` (pytest **15 passed**).

## Third pass (2026-09-03, same branch)

- **Depth-resolved current vectors** — `VectorLayer`, `FlowLineLayer` and the 2D map's vectors +
  animated flow now read `copernicus_marine` uo/vo (40 levels) instead of surface-only
  `incois_ocean`. Arrows/streamlines follow the depth slider through the water column.
  Verified: mean |uo| 0.20→0.04 m/s from 0→500 m. Eddy detector stays on INCOIS (surface diagnostic).
- **Delimited-text depth + time** — `DelimitedTextAdapter` rewritten: sniffs delimiter, resolves
  lat/lon/depth/time aliases, `groupby(dims).mean().to_xarray()` → (time?, depth?, lat, lon) cube,
  exposes all numeric value columns. 2-D CSVs still collapse to (lat, lon). `get_profile_at` added
  for model-delta. `upload.py::_introspect_text` matched to the same alias/axis logic.
  Test: `test_delimited_text_depth_time` (pytest **14 passed**).

### Still open from the PS gap analysis
- Globe `FlowLineLayer` is streamline-geometry with a shader pulse, not true particle advection
  (the 2D map has real particle advection). Fine visually; note if asked.
- No SLD / styled-layer support in the hand-rolled WMS; WCS 2.0.1 capabilities still minimal.
  Not opened in QGIS.
- Exact INCOIS LAS / Copernicus GLOBAL_MULTIYEAR_PHY_001_030 datasets (item 8) — LAS is down.
- Outreach: single canned flythrough, no mobile layout, no shareable view state.
- **Nothing on this branch is browser-verified** — needs `docker compose up` + click-through.

## Missing: ML / algorithmic stretch features (README §14)

None of these exist anywhere in `backend/app` yet. They were always scoped
as optional — "must never block the MVP path" — so their absence is not a
gap in the required deliverable, just unclaimed upside.

- [x] **Okubo–Weiss eddy detection** — a deterministic vorticity/strain-rate
      filter over the current-vector field (`water_u`/`water_v`), computed
      server-side and returned as a highlighted region overlay. Not a
      trained model — a real technique from published ocean-science
      literature (see README §3.2, pyParaOcean). The single feature most
      likely to read as genuine domain sophistication to an INCOIS
      reviewer.
- [ ] **Surface-front / water-mass tracking** — same category: a
      deterministic algorithmic filter on salinity/temperature gradients.
- [ ] **Model-vs-observation delta** — a simple numeric comparison (not ML)
      between the nearest model grid cell and a real Argo profile at the
      same location/time, surfaced as a diagnostic overlay. Useful to the
      "operational forecaster" persona specifically.

Note: the only "eddy" hits currently in the codebase are hardcoded
warm/cold-core bumps in `backend/app/ingest/generate_fixtures.py`'s
synthetic demo-data generator — cosmetic realism for the fixture data, not
a detection algorithm.

## Self-flagged incomplete

- [ ] **Acronym glossary + dataset link tables** — flagged as left
      unfinished in commit `2d33c97`'s message ("Acronyms + Dataset Link
      Tables left, all done"). Likely a reference/glossary section for the
      README or an in-app help panel. Not independently verified beyond
      the commit message — needs a look to confirm scope before starting.

## Already done (for reference — don't re-build these)

- All 7 registry sources (`argo_profiles`, `copernicus_salinity`,
  `copernicus_temp`, `hf_radar_currents`, `hycom_salinity`,
  `hycom_water_temp`, `mock_bgc_chlorophyll`) have working renderers,
  including `VectorLayer.ts` for `hf_radar_currents`'s vector render type.
- Both ingestion adapters demoed (`NetCDFAdapter`, `DelimitedTextAdapter`).
- Isosurface toggle (`ControlPanel.tsx`, slice/volume/isosurface switch).
- Both UI modes (`ForecasterConsole`, `ExplorerMode`) fully built.
- Search bar + geocoding (`SearchBar.tsx`, `api/geocode.ts`).
- Full i18n system (`i18n/translations.ts`, `useT.ts`,
  `LanguageSwitcher.tsx`) — covers the "multilingual Explorer Mode" item.
- CI (`backend` / `frontend` / `docker-smoke` jobs) green on `main`.
