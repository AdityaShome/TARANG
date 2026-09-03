import React, { useEffect, useState } from 'react'

const GLOSSARY_TERMS = [
  { term: 'EEZ', def: 'Exclusive Economic Zone' },
  { term: 'INCOIS', def: 'Indian National Centre for Ocean Information Services' },
  { term: 'MoES', def: 'Ministry of Earth Sciences (Govt. of India)' },
  { term: 'CTD', def: 'Conductivity, Temperature, Depth (sensor package)' },
  { term: 'BGC (-Argo)', def: 'Biogeochemical Argo (chlorophyll, oxygen, nitrate, pH sensors)' },
  { term: 'NetCDF', def: 'Network Common Data Form' },
  { term: 'OPeNDAP', def: 'Open-source Project for a Network Data Access Protocol' },
  { term: 'OGC', def: 'Open Geospatial Consortium' },
  { term: 'WMS', def: 'Web Map Service (OGC standard)' },
  { term: 'WCS', def: 'Web Coverage Service (OGC standard)' },
  { term: 'CF Conventions', def: 'Climate and Forecast metadata conventions for NetCDF' },
  { term: 'GDAC', def: 'Global Data Assembly Centre (Argo data)' },
  { term: 'ADCP', def: 'Acoustic Doppler Current Profiler' },
  { term: 'HF-Radar', def: 'High-Frequency Radar (surface current measurement)' },
  { term: 'SST', def: 'Sea Surface Temperature' },
  { term: 'LOD', def: 'Level of Detail' },
  { term: 'TDS', def: 'THREDDS Data Server' },
  { term: 'NCSS', def: 'NetCDF Subset Service' },
  { term: 'REST', def: 'Representational State Transfer' },
  { term: 'GLSL', def: 'OpenGL Shading Language' },
  { term: 'PFZ', def: 'Potential Fishing Zone (an existing INCOIS advisory service)' },
  { term: 'HYCOM', def: 'Hybrid Coordinate Ocean Model' },
  { term: 'ROMS', def: 'Regional Ocean Modeling System' },
  { term: 'GODAS', def: 'Global Ocean Data Assimilation System' },
  { term: 'MOM', def: 'Modular Ocean Model' },
  { term: 'BoB', def: 'Bay of Bengal' },
  { term: 'AS', def: 'Arabian Sea' },
  { term: 'SIH', def: 'Smart India Hackathon' },
  { term: 'PS', def: 'Problem Statement' },
  { term: 'OMNI-RAMA', def: 'Ocean Moored buoy Network for Northern Indian Ocean - Research Moored Array for African-Asian-Australian Monsoon Analysis and Prediction' },
  { term: 'RAMA', def: 'Research Moored Array for African-Asian-Australian Monsoon Analysis and Prediction' },
  { term: 'TMI', def: 'TRMM Microwave Imager' },
  { term: 'GPS', def: 'Global Positioning System' },
  { term: 'JSON', def: 'JavaScript Object Notation' },
  { term: 'YAML', def: "YAML Ain't Markup Language" },
  { term: 'WMO', def: 'World Meteorological Organization' },
  { term: 'CSS', def: 'Cascading Style Sheets' },
  { term: 'CLI', def: 'Command Line Interface' },
  { term: 'API', def: 'Application Programming Interface' }
]

import { useTarangStore } from '../state/store'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

interface OgcSource {
  id: string; label: string; standard_name: string; units: string
  opendap?: string; wms?: string; wcs?: string; ncss?: string
  wms_option_b: string; wcs_option_b: string
}
interface OgcEndpoints {
  conventions: string
  service_catalogs: Record<string, string>
  sources: OgcSource[]
}

export function GlossaryPanel({ onClose }: { onClose: () => void }) {
  const [search, setSearch] = useState('')
  const sources = useTarangStore(s => s.sources)
  const [ogc, setOgc] = useState<OgcEndpoints | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/ogc/endpoints`)
      .then(r => (r.ok ? r.json() : null))
      .then(setOgc)
      .catch(() => setOgc(null))
  }, [])

  const filtered = GLOSSARY_TERMS.filter(item => 
    item.term.toLowerCase().includes(search.toLowerCase()) || 
    item.def.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <div style={styles.title}>Glossary & Acronyms</div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        
        <input 
          type="text" 
          placeholder="Search glossary..." 
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        
        <div style={styles.list}>
          {sources.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ color: '#00d4ff', fontSize: '15px', fontWeight: '600', marginBottom: '10px', borderBottom: '1px solid rgba(0, 180, 255, 0.2)', paddingBottom: '4px' }}>
                Active Datasets (Data Provenance)
              </div>
              {sources.map(s => (
                <div key={s.id} style={{ ...styles.item, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={styles.term}>{s.label}</div>
                  <div style={styles.def}>Registry ID: <code>{s.id}</code></div>
                  <div style={styles.def}>
                    <a href={`http://localhost:8080/thredds/catalog/tarang/catalog.html`} target="_blank" rel="noreferrer" style={{ color: '#00d4ff', textDecoration: 'none' }}>
                      [View on THREDDS]
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}

          {ogc && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ color: '#00d4ff', fontSize: '15px', fontWeight: '600', marginBottom: '4px', borderBottom: '1px solid rgba(0, 180, 255, 0.2)', paddingBottom: '4px' }}>
                Open-Standards Data Access ({ogc.conventions})
              </div>
              <div style={{ ...styles.def, marginBottom: '10px' }}>
                Every source is reachable over OGC WMS/WCS (served by the app) and, when the
                THREDDS container is up, OPeNDAP + NCSS. Open these in QGIS, Panoply, or a browser.{' '}
                <a href={ogc.service_catalogs.wms_capabilities_option_b} target="_blank" rel="noreferrer" style={{ color: '#00d4ff' }}>WMS GetCapabilities</a>
                {' · '}
                <a href={ogc.service_catalogs.wcs_capabilities_option_b} target="_blank" rel="noreferrer" style={{ color: '#00d4ff' }}>WCS GetCapabilities</a>
              </div>
              {ogc.sources.map(s => (
                <div key={s.id} style={{ ...styles.item, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={styles.term}>{s.label}</div>
                  <div style={styles.def}>
                    CF <code>{s.standard_name}</code> ({s.units})
                  </div>
                  <div style={{ ...styles.def, display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    <a href={s.wms_option_b} target="_blank" rel="noreferrer" style={{ color: '#00d4ff' }}>WMS GetMap</a>
                    <a href={s.wcs_option_b} target="_blank" rel="noreferrer" style={{ color: '#00d4ff' }}>WCS GetCoverage</a>
                    {s.opendap && <a href={s.opendap} target="_blank" rel="noreferrer" style={{ color: '#7fb0d8' }}>OPeNDAP (THREDDS)</a>}
                    {s.ncss && <a href={s.ncss} target="_blank" rel="noreferrer" style={{ color: '#7fb0d8' }}>NCSS (THREDDS)</a>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ color: '#00d4ff', fontSize: '15px', fontWeight: '600', marginBottom: '10px', borderBottom: '1px solid rgba(0, 180, 255, 0.2)', paddingBottom: '4px' }}>
            Acronyms & Terms
          </div>
          {filtered.map(item => (
            <div key={item.term} style={styles.item}>
              <div style={styles.term}>{item.term}</div>
              <div style={styles.def}>{item.def}</div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ color: '#a0c4e8', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>
              No terms found.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 5, 15, 0.4)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  panel: {
    width: '500px',
    maxHeight: '80vh',
    background: 'rgba(8, 15, 30, 0.95)',
    border: '1px solid rgba(0, 180, 255, 0.25)',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0, 50, 100, 0.4)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '20px',
    borderBottom: '1px solid rgba(0, 180, 255, 0.15)',
  },
  title: {
    color: '#00d4ff',
    fontSize: '18px',
    fontWeight: '600',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'rgba(160, 196, 232, 0.6)',
    fontSize: '20px',
    cursor: 'pointer',
    padding: 0,
  },
  searchInput: {
    margin: '20px',
    padding: '10px 14px',
    background: 'rgba(0, 30, 60, 0.8)',
    border: '1px solid rgba(0, 180, 255, 0.2)',
    borderRadius: '6px',
    color: '#e0f0ff',
    fontSize: '14px',
    outline: 'none',
  },
  list: {
    overflowY: 'auto',
    padding: '0 20px 20px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  item: {
    background: 'rgba(255, 255, 255, 0.03)',
    padding: '12px',
    borderRadius: '8px',
  },
  term: {
    color: '#e0f0ff',
    fontWeight: '600',
    fontSize: '14px',
    marginBottom: '4px',
  },
  def: {
    color: '#a0c4e8',
    fontSize: '13px',
    lineHeight: '1.4',
  }
}
