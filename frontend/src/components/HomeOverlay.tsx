import React, { useState, useEffect, useRef } from 'react'
import { useTarangStore } from '../state/store'
import { useT } from '../i18n/useT'
import { LANGUAGES } from '../i18n/translations'

const IconGlobe = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="2" y1="12" x2="22" y2="12"></line>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
  </svg>
)

const IconLayers = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
    <polyline points="2 12 12 17 22 12"></polyline>
    <polyline points="2 17 12 22 22 17"></polyline>
  </svg>
)

const IconSliders = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="21" x2="4" y2="14"></line>
    <line x1="4" y1="10" x2="4" y2="3"></line>
    <line x1="12" y1="21" x2="12" y2="12"></line>
    <line x1="12" y1="8" x2="12" y2="3"></line>
    <line x1="20" y1="21" x2="20" y2="16"></line>
    <line x1="20" y1="12" x2="20" y2="3"></line>
    <line x1="1" y1="14" x2="7" y2="14"></line>
    <line x1="9" y1="8" x2="15" y2="8"></line>
    <line x1="17" y1="16" x2="23" y2="16"></line>
  </svg>
)

export function HomeOverlay() {
  const showHomeOverlay = useTarangStore(s => s.showHomeOverlay)
  const setShowHomeOverlay = useTarangStore(s => s.setShowHomeOverlay)
  const language = useTarangStore(s => s.language)
  const setLanguage = useTarangStore(s => s.setLanguage)
  const t = useT()

  const [isFadingOut, setIsFadingOut] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.body.style.overflow = showHomeOverlay ? 'hidden' : 'auto'
    return () => { document.body.style.overflow = 'auto' }
  }, [showHomeOverlay])

  if (!showHomeOverlay && !isFadingOut) return null

  const handleStart = () => {
    setIsFadingOut(true)
    setTimeout(() => {
      setShowHomeOverlay(false)
      setIsFadingOut(false)
    }, 800)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    // Calculate mouse position relative to center of screen (-1 to 1)
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const y = ((e.clientY - rect.top) / rect.height) * 2 - 1
    setMousePos({ x, y })
  }

  // Calculate 3D rotations based on mouse position
  const rotateX = mousePos.y * -10 // max 10 deg
  const rotateY = mousePos.x * 10  // max 10 deg

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end', // Align HUD to the right
        background: 'transparent',
        opacity: isFadingOut ? 0 : 1,
        transform: isFadingOut ? 'scale(1.1)' : 'scale(1)',
        transition: 'all 0.8s cubic-bezier(0.85, 0, 0.15, 1)',
        pointerEvents: isFadingOut ? 'none' : 'auto',
        color: '#e0f0ff',
        overflow: 'hidden',
        perspective: '1500px',
      }}
    >
      {/* ── Massive 3D HUD Panel on the right ── */}
      <div 
        style={{
          position: 'relative',
          width: '50%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 80px',
          background: 'linear-gradient(90deg, rgba(2,8,16,0) 0%, rgba(2,8,16,0.8) 40%, rgba(2,8,16,0.95) 100%)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderLeft: '1px solid rgba(0, 212, 255, 0.2)',
          transformStyle: 'preserve-3d',
          transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`,
          transition: 'transform 0.1s ease-out',
        }}
      >
        {/* Decorative HUD Elements */}
        <div style={{ position: 'absolute', top: '10%', left: '-1px', width: '2px', height: '100px', background: '#00d4ff', boxShadow: '0 0 10px #00d4ff' }} />
        <div style={{ position: 'absolute', bottom: '20%', left: '-1px', width: '2px', height: '50px', background: '#00d4ff', boxShadow: '0 0 10px #00d4ff' }} />

        <div style={{ 
          transform: 'translateZ(60px)', 
          animation: 'slide-up-stagger 1s cubic-bezier(0.16, 1, 0.3, 1) forwards' 
        }}>
          <div style={{ color: '#00d4ff', fontSize: '14px', letterSpacing: '4px', textTransform: 'uppercase', marginBottom: '10px', fontWeight: 600 }}>
            System Initialized // INCOIS
          </div>
          
          <h1 style={{ 
            fontSize: '5.5rem', 
            fontWeight: '900', 
            margin: '0 0 10px 0',
            lineHeight: 1,
            background: 'linear-gradient(135deg, #ffffff 0%, #00d4ff 50%, #1046ff 100%)',
            backgroundSize: '200% auto',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '-2px',
            animation: 'gradient-text-shift 5s linear infinite',
            textShadow: '0 20px 40px rgba(0,0,0,0.5)',
          }}>
            {t('homeWelcome')}
          </h1>
          
          <p style={{ 
            fontSize: '1.6rem', 
            color: '#a0c4e8', 
            marginBottom: '40px', 
            fontWeight: '300', 
            letterSpacing: '1px' 
          }}>
            {t('explorerBrandSub')}
          </p>
        </div>

        {/* Language Selector in 3D Space */}
        <div style={{ 
          display: 'flex', gap: '15px', marginBottom: '60px', flexWrap: 'wrap',
          transform: 'translateZ(40px)',
          animation: 'slide-up-stagger 1s cubic-bezier(0.16, 1, 0.3, 1) forwards',
          animationDelay: '0.15s', opacity: 0
        }}>
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => setLanguage(lang.code)}
              style={{
                background: language === lang.code ? 'rgba(0, 212, 255, 0.2)' : 'rgba(255, 255, 255, 0.02)',
                border: `1px solid ${language === lang.code ? '#00d4ff' : 'rgba(255, 255, 255, 0.1)'}`,
                color: language === lang.code ? '#fff' : '#8faadc',
                padding: '10px 24px',
                borderRadius: '4px', // Hard edges for HUD feel
                cursor: 'pointer',
                fontSize: '13px',
                textTransform: 'uppercase',
                letterSpacing: '2px',
                fontWeight: '600',
                transition: 'all 0.3s ease',
                boxShadow: language === lang.code ? '0 0 20px rgba(0, 212, 255, 0.4)' : 'none',
              }}
              onMouseOver={e => {
                if (language !== lang.code) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'
              }}
              onMouseOut={e => {
                if (language !== lang.code) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)'
              }}
            >
              {lang.nativeLabel}
            </button>
          ))}
        </div>

        {/* Steps Grid */}
        <div style={{ 
          width: '100%', marginBottom: '60px',
          transform: 'translateZ(30px)',
          animation: 'slide-up-stagger 1s cubic-bezier(0.16, 1, 0.3, 1) forwards',
          animationDelay: '0.3s', opacity: 0
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {[
              { icon: <IconGlobe />, text: t('homeStep1'), num: '01' },
              { icon: <IconLayers />, text: t('homeStep2'), num: '02' },
              { icon: <IconSliders />, text: t('homeStep3'), num: '03' },
            ].map((step, idx) => (
              <div key={idx} style={{ 
                background: 'rgba(255, 255, 255, 0.02)', 
                borderLeft: '2px solid rgba(255, 255, 255, 0.1)',
                padding: '20px 30px',
                display: 'flex', alignItems: 'center', gap: '25px',
                transition: 'all 0.3s ease',
                cursor: 'default',
                position: 'relative',
                overflow: 'hidden'
              }}
              onMouseOver={e => {
                e.currentTarget.style.transform = 'translateX(10px)'
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                e.currentTarget.style.borderLeftColor = '#00d4ff'
              }}
              onMouseOut={e => {
                e.currentTarget.style.transform = 'translateX(0)'
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)'
                e.currentTarget.style.borderLeftColor = 'rgba(255, 255, 255, 0.1)'
              }}>
                <div style={{ position: 'absolute', right: '-20px', top: '-20px', fontSize: '100px', fontWeight: 900, color: 'rgba(255,255,255,0.03)', pointerEvents: 'none' }}>
                  {step.num}
                </div>
                <div style={{ color: '#00d4ff' }}>
                  {step.icon}
                </div>
                <div style={{ color: '#cce0ff', lineHeight: '1.6', fontSize: '15px', fontWeight: 400, maxWidth: '80%' }}>
                  {step.text}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Start Button */}
        <div style={{
          transform: 'translateZ(80px)',
          animation: 'slide-up-stagger 1s cubic-bezier(0.16, 1, 0.3, 1) forwards',
          animationDelay: '0.45s', opacity: 0
        }}>
          <button
            onClick={handleStart}
            style={{
              background: 'transparent',
              color: '#00d4ff',
              border: '2px solid #00d4ff',
              padding: '20px 60px',
              fontSize: '18px',
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: '3px',
              cursor: 'pointer',
              boxShadow: '0 0 20px rgba(0, 212, 255, 0.2), inset 0 0 20px rgba(0, 212, 255, 0.2)',
              transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              position: 'relative',
              overflow: 'hidden',
            }}
            onMouseOver={e => {
              e.currentTarget.style.background = '#00d4ff'
              e.currentTarget.style.color = '#020810'
              e.currentTarget.style.boxShadow = '0 0 40px rgba(0, 212, 255, 0.6), inset 0 0 20px rgba(255, 255, 255, 0.8)'
              e.currentTarget.style.transform = 'scale(1.05)'
            }}
            onMouseOut={e => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = '#00d4ff'
              e.currentTarget.style.boxShadow = '0 0 20px rgba(0, 212, 255, 0.2), inset 0 0 20px rgba(0, 212, 255, 0.2)'
              e.currentTarget.style.transform = 'scale(1)'
            }}
          >
            {t('homeStartBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
