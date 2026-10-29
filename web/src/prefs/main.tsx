import "../styles/preferences.css";

import { render } from "solid-js/web";
import { connectPrefs } from "./api";
import { Preferences } from "./Preferences";

const api = await connectPrefs();
const [settings, themes] = await Promise.all([api.settings(), api.themes()]);
render(() => <Preferences api={api} settings={settings} themes={themes} />, document.body);
// Tests drive the browser build through this.
Object.assign(window, { marporaPrefs: api });
