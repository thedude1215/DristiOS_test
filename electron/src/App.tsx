import { useEffect } from 'react';
import LiquidGlass from 'liquid-glass-react';
import { VoiceAgent } from './components/VoiceAgent';

function App() {
  // Handle window dragging - make glass non-interactive during drag
  useEffect(() => {
    const handleMouseDown = () => {};
    const handleMouseUp = () => {};
    
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div 
      style={{ 
        width: '100vw', 
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        position: 'relative',
      }}
    >
      {/* Glass effect as background layer */}
      <LiquidGlass
        displacementScale={30}
        blurAmount={1.5}
        saturation={150}
        aberrationIntensity={1}
        elasticity={0.15}
        cornerRadius={26}
        style={{
          width: '700px',
          height: '350px',
          position: 'absolute',
        }}
        className="no-drag"
      >
        {/* Empty - just the glass effect */}
        <div style={{ width: '100%', height: '100%' }} />
      </LiquidGlass>

      {/* Subtle tinted background like macOS widgets */}
      <div style={{
        width: '700px',
        height: '350px',
        position: 'absolute',
        zIndex: 1,
        borderRadius: '26px',
        background: 'rgba(0, 0, 0, 0.25)',
        pointerEvents: 'none',
      }} />

      {/* Content layer on top of glass */}
      <div style={{
        width: '700px',
        height: '350px',
        position: 'absolute',
        zIndex: 2,
      }}>
        <VoiceAgent />
      </div>
    </div>
  );
}

export default App;
