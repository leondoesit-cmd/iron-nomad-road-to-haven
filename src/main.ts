import './ui/styles.css';
import { Game } from './game/game';
import { initSave } from './save/save';

const game = new Game();
declare global {
  interface Window {
    __game?: Game;
  }
}
window.__game = game;
void initSave().finally(() => game.start());
