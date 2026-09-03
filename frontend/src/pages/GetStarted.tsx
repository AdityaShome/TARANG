import "./GetStarted.css";

interface Step {
  icon: string;
  title: string;
  sub: string;
  desc: string;
  tip: string;
}

const steps: Step[] = [
  { icon: "🚀", title: "Start Exploring", sub: "Open TARANG", desc: "Click Start Exploring on the home page to open the main TARANG ocean visualization workspace.", tip: "This is where your ocean exploration begins." },
  { icon: "🌐", title: "Choose an Area", sub: "Where do you want to explore?", desc: "Select the part of the ocean you want to study. You can explore different regions using the map and globe.", tip: "Try the Bay of Bengal, Arabian Sea or Indian Ocean." },
  { icon: "🗄️", title: "Choose Your Data", sub: "Where does the information come from?", desc: "Select a data source that contains the ocean information you want to explore.", tip: "Choose one of the available ocean datasets." },
  { icon: "🌊", title: "Choose What to See", sub: "Select a variable", desc: "Choose the ocean information you want to visualize. This tells TARANG what you want to study.", tip: "Temperature • Salinity • Currents" },

  { icon: "🎚️", title: "Choose the View", sub: "How do you want to see it?", desc: "Choose how TARANG should display your selected ocean data.", tip: "Slice • Volume • Iso • Cube / 3D" },
  { icon: "📦", title: "Explore Depth & Time", sub: "Look below the surface", desc: "Move through different ocean depths and available time steps to understand how ocean conditions change.", tip: "Surface → 10 m → 30 m → 100 m" },
  { icon: "📚", title: "Turn Layers On or Off", sub: "Show what you need", desc: "Use the Layers controls to decide which additional information appears on your visualization.", tip: "Currents • Thermal Fronts • Eddy Rings • Markers • Vectors" },
  { icon: "⚙️", title: "Customize Your View", sub: "Make it easier to understand", desc: "Adjust the appearance of your visualization using controls such as opacity, colormap and value range.", tip: "Change colors, transparency and other settings." },

  { icon: "✨", title: "Ask AI Copilot", sub: "Just tell TARANG what you want", desc: "You can use the AI Copilot to control the visualization using natural language.", tip: "\u201cShow temperature at 30m\u201d or \u201cTurn on thermal fronts\u201d." },
  { icon: "🌍", title: "Explore in 3D", sub: "See the bigger picture", desc: "Switch to a globe or 3D view to explore ocean data from a different perspective.", tip: "Switch between India View and Globe View." },
  { icon: "⬇️", title: "Save Your Result", sub: "Download your view", desc: "Once you have created the visualization you need, use the available download or export options to save your result.", tip: "Save your selected view or supported NetCDF data." },
];

function SnakeConnector() {
  return (
    <div className="gs-row-connector">
      <svg viewBox="0 0 1000 64" preserveAspectRatio="none" width="100%" height="64">
        <path
          d="M 970 0 C 970 30, 970 40, 900 40 L 60 40 C 20 40, 20 50, 20 64"
          fill="none"
          stroke="#2fd3f5"
          strokeWidth="2"
          strokeDasharray="1 7"
          strokeLinecap="round"
        />
        <polygon points="14,58 26,58 20,68" fill="#2fd3f5" />
      </svg>
    </div>
  );
}

function StepCard({ step, num, isLastInRow }: { step: Step; num: number; isLastInRow: boolean }) {
  return (
    <div className="gs-card-cell">
      {!isLastInRow && <div className="gs-h-connector" />}
      <div className="gs-card">
        <div className="gs-card-top">
          <div className="gs-card-num">{String(num).padStart(2, "0")}</div>
          <div className="gs-card-icon">{step.icon}</div>
        </div>
        <h3>{step.title}</h3>
        <div className="gs-sub">{step.sub}</div>
        <p className="gs-desc">{step.desc}</p>
        <div className="gs-tip">
          <span>💡</span>
          <span>{step.tip}</span>
        </div>
      </div>
    </div>
  );
}

interface GetStartedProps {
  onBack: () => void;
  onStartExploring: () => void;
}

export default function GetStarted({ onBack, onStartExploring }: GetStartedProps) {
  const row1 = steps.slice(0, 4);
  const row2 = steps.slice(4, 8);
  const row3 = steps.slice(8, 11);

  return (
    <div className="gs-root gs-page">
      <div className="gs-top-bar">
        <button className="gs-back-btn" onClick={onBack}>
          ← Back
        </button>
        <div className="gs-top-brand">
          <div className="gs-logo">🌊</div>
          <div>
            <span className="gs-name">TARANG</span>
            <small>Ocean Visualization</small>
          </div>
        </div>
        <button className="gs-close-btn" onClick={onBack}>
          ×
        </button>
      </div>

      <div className="gs-intro-card">
        <div className="gs-intro-icon">✨</div>
        <div>
          <h2>
            Explore <span className="gs-accent">TARANG</span>
          </h2>
          <p>Follow these simple steps to explore and understand ocean data.</p>
        </div>
      </div>

      <div className="gs-grid-wrap">
        <div className="gs-row gs-r1">
          {row1.map((s, i) => (
            <StepCard key={s.title} step={s} num={i + 1} isLastInRow={i === row1.length - 1} />
          ))}
          <SnakeConnector />
        </div>

        <div className="gs-row gs-r2">
          {row2.map((s, i) => (
            <StepCard key={s.title} step={s} num={i + 5} isLastInRow={i === row2.length - 1} />
          ))}
          <SnakeConnector />
        </div>

        <div className="gs-row gs-r3">
          {row3.map((s, i) => (
            <StepCard key={s.title} step={s} num={i + 9} isLastInRow={i === row3.length - 1} />
          ))}
          <div className="gs-card-cell gs-ghost">
            <div className="gs-card" />
          </div>
        </div>
      </div>

      <div className="gs-footer-card">
        <div className="gs-footer-left">
          <div className="gs-footer-logo" />
          <div>
            <h3>You're ready to explore!</h3>
            <p>Choose an area, select your data, explore depth and time, control layers, and use AI Copilot whenever you need help.</p>
          </div>
        </div>
        <button className="gs-footer-cta" onClick={onStartExploring}>
          START EXPLORING →
        </button>
      </div>
    </div>
  );
}