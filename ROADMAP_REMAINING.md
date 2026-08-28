# TARANG — Remaining Work

Status snapshot as of the current `main` branch. Every Must-have and
Should-have from the README's MoSCoW list (§13) is done. What's left is
optional stretch work, not required deliverables.

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
