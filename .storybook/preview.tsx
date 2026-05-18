import "@client/lib/setupLightweightChartsGlobal";
import "../src/client/globals.css";
import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i } },
    backgrounds: {
      default: "trading",
      values: [{ name: "trading", value: "#131722" }],
    },
    viewport: {
      defaultViewport: "chartLg",
      viewports: {
        chartLg: { name: "Chart 1280×720", styles: { width: "1280px", height: "720px" } },
        chartSm: { name: "Chart 800×400", styles: { width: "800px", height: "400px" } },
      },
    },
  },
  decorators: [
    // lightweight-charts measures its container at mount. Without explicit
    // dimensions the Storybook iframe is 0×0 → chart never paints → blank
    // screenshot. Force a known size so charts always have room.
    (Story) => (
      <div style={{ width: 1024, height: 600 }}>
        <Story />
      </div>
    ),
  ],
};
export default preview;
