import { useState } from 'react'
import './App.css'
import { useSimulationLoop } from './app/useSimulationLoop'
import { SimulationCanvas } from './app/SimulationCanvas'
import { ControlPanel } from './app/ControlPanel'
import { DebugPanel } from './app/DebugPanel'
import { TrainingReplayPanel } from './app/TrainingReplayPanel'

function App() {
  const loop = useSimulationLoop()
  const [showVision, setShowVision] = useState(true)
  const [showAttackRange, setShowAttackRange] = useState(true)
  const [showPatch, setShowPatch] = useState(false)
  const [obliqueView, setObliqueView] = useState(false)

  return (
    <div id="game-root">
      <main>
        <SimulationCanvas
          getState={loop.getState}
          tick={loop.tick}
          episode={loop.episode}
          selectedUnitId={loop.selectedUnitId}
          onSelectUnit={loop.selectUnit}
          showVision={showVision}
          showAttackRange={showAttackRange}
          showPatch={showPatch}
          obliqueView={obliqueView}
        />
        <div className="side-column">
          <TrainingReplayPanel onLoadReplay={loop.loadReplay} />
          <ControlPanel
            playing={loop.playing}
            ticksPerSecond={loop.ticksPerSecond}
            mode={loop.mode}
            seed={loop.seed}
            configForm={loop.configForm}
            canReplay={loop.canReplay}
            gameOver={loop.gameOver}
            botAssignment={loop.botAssignment}
            rlSlotStatus={loop.rlSlotStatus}
            onPlay={loop.play}
            onPause={loop.pause}
            onStepOnce={loop.stepOnce}
            onSetTicksPerSecond={loop.setTicksPerSecond}
            onReset={loop.reset}
            onStartReplay={loop.startReplay}
            onSetTeamBot={loop.setTeamBot}
            showVision={showVision}
            showAttackRange={showAttackRange}
            showPatch={showPatch}
            obliqueView={obliqueView}
            onToggleVision={() => setShowVision((v) => !v)}
            onToggleAttackRange={() => setShowAttackRange((v) => !v)}
            onTogglePatch={() => setShowPatch((v) => !v)}
            onToggleObliqueView={() => setObliqueView((v) => !v)}
          />
        </div>
        <div className="side-column">
          <DebugPanel state={loop.getState()} selectedUnitId={loop.selectedUnitId} />
        </div>
      </main>
    </div>
  )
}

export default App
