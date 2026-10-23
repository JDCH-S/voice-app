import { useNavigate } from 'react-router-dom';
import CalibrationWizard from '../components/CalibrationWizard';
import { useApp } from '../lib/AppContext';

export default function Calibration() {
  const { updateProfile } = useApp();
  const nav = useNavigate();
  return (
    <div style={{ maxWidth: 800 }}>
      <div className="card">
        <CalibrationWizard
          onDone={async (cal) => {
            await updateProfile({ calibration: cal });
            nav(-1);
          }}
        />
      </div>
    </div>
  );
}
