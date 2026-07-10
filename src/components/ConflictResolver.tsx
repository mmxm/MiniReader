import React from 'react';

interface ConflictResolverProps {
  isOpen: boolean;
  bookTitle: string;
  localProgress: number;
  localDate: string;
  remoteProgress: number;
  remoteDate: string;
  onResolve: (choice: 'local' | 'remote') => void;
}

export const ConflictResolver: React.FC<ConflictResolverProps> = ({
  isOpen,
  bookTitle,
  localProgress,
  localDate,
  remoteProgress,
  remoteDate,
  onResolve,
}) => {
  if (!isOpen) return null;

  const formatDate = (isoString: string) => {
    if (!isoString) return 'Inconnue';
    try {
      const date = new Date(isoString);
      return date.toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-card glass">
        <h2 className="modal-title">Conflit de synchronisation</h2>
        <p className="modal-subtitle">
          Une différence de progression a été détectée pour le livre <strong>{bookTitle}</strong>. 
          Veuillez choisir la position de lecture à conserver :
        </p>

        <div className="conflict-options">
          {/* Option Locale */}
          <button 
            type="button" 
            className="conflict-box local-box" 
            onClick={() => onResolve('local')}
          >
            <div className="box-badge">Cet appareil (Local)</div>
            <div className="box-percent">{Math.round(localProgress)}%</div>
            <div className="box-date">Enregistré le : {formatDate(localDate)}</div>
          </button>

          {/* Option Distante (BookOrbit) */}
          <button 
            type="button" 
            className="conflict-box remote-box" 
            onClick={() => onResolve('remote')}
          >
            <div className="box-badge">BookOrbit (En ligne)</div>
            <div className="box-percent">{Math.round(remoteProgress)}%</div>
            <div className="box-date">Enregistré le : {formatDate(remoteDate)}</div>
          </button>
        </div>

        <p className="conflict-notice">
          La progression choisie sera appliquée localement et renvoyée sur votre serveur BookOrbit pour mettre à jour tous vos appareils.
        </p>
      </div>
    </div>
  );
};
