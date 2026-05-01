import { BUILTIN_TEMPLATES } from './dist/builtins/templates.js';
import { parseTemplate } from './dist/templates/loader.js';
import { renderTemplate } from './dist/templates/render.js';

const file = BUILTIN_TEMPLATES.find(f => f.relPath.endsWith('design-system.yaml'));
const parsed = parseTemplate(file.content, file.relPath);
if (!parsed.ok) { console.log('TPL FAIL:', parsed.error.message); process.exit(1); }

const r = renderTemplate({
  template: parsed.value,
  inputs: {
    name: 'Heritage',
    description: 'A premium broadsheet aesthetic.',
    frontmatter_yaml: `colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
  tertiary: "#B8422E"
  neutral: "#F7F5F2"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 3rem
  body-md:
    fontFamily: Public Sans
    fontSize: 1rem
rounded:
  sm: 4px
  md: 8px
spacing:
  sm: 8px
  md: 16px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"`,
    overview: 'Architectural Minimalism meets Journalistic Gravitas.',
    colors_prose: '- **Primary (#1A1C1E):** Deep ink for headlines.\n- **Tertiary (#B8422E):** Boston Clay for CTAs.',
    typography_prose: '- **h1:** Public Sans 3rem for headlines.\n- **body-md:** Public Sans 1rem for prose.',
    components_prose: 'Buttons follow the primary/secondary contrast pair above.'
  }
});

if (!r.ok) { console.log('RENDER FAIL:', r.error.message); process.exit(1); }
console.log('---OUTPUT---');
console.log(r.value.content);
console.log('---END---');
