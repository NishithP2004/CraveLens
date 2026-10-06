import "/admin/vendor/chart.js";
const Chart = globalThis.Chart;
const palette = ["#ff5b38", "#f4bd84", "#8ba6a0", "#b9a7d0"];
Chart.defaults.color = getComputedStyle(document.documentElement)
  .getPropertyValue("--muted")
  .trim();
Chart.defaults.borderColor = getComputedStyle(document.documentElement)
  .getPropertyValue("--grid")
  .trim();
Chart.defaults.font.family = "DM Sans, system-ui, sans-serif";
const instances = new Map();
function syncChartThemes() {
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue("--muted").trim();
  Chart.defaults.borderColor = css.getPropertyValue("--grid").trim();
  for (const plot of instances.values()) {
    for (const scale of Object.values(plot.options.scales || {})) {
      scale.ticks.color = Chart.defaults.color;
      scale.grid.color = Chart.defaults.borderColor;
    }
    plot.options.plugins.legend.labels.color = Chart.defaults.color;
    plot.update("none");
  }
}
document.addEventListener("cravelens:theme", syncChartThemes);
export function chart(
  target,
  type,
  labels,
  datasets,
  { horizontal = false, timeline = false } = {},
) {
  instances.get(target)?.destroy();
  instances.delete(target);
  target.replaceChildren();
  if (!labels.length || !datasets.some((d) => d.data.some((n) => n > 0))) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No recorded activity in this window.";
    target.append(empty);
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.className = `chart-frame${type === "doughnut" ? " chart-ring" : ""}`;
  if (horizontal)
    wrapper.style.height = `${Math.max(200, labels.length * 34)}px`;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    `${target.id}: ${labels.map((label, i) => `${label}, ${datasets.map((d) => `${d.label}: ${d.data[i]}`).join(", ")}`).join("; ")}`,
  );
  wrapper.append(canvas);
  target.append(wrapper);
  const plot = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: datasets.map((d, i) => ({
        backgroundColor:
          type === "doughnut" ? palette : palette[i % palette.length],
        borderColor: palette[i % palette.length],
        borderRadius: 5,
        borderWidth: type === "line" ? 2 : 0,
        pointRadius: 2,
        pointHoverRadius: 5,
        tension: 0.25,
        ...d,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: horizontal ? "y" : "x",
      interaction: {
        mode: type === "doughnut" ? "nearest" : "index",
        intersect: false,
      },
      plugins: {
        legend: {
          display: type === "doughnut" || datasets.length > 1,
          position: "bottom",
          labels: { usePointStyle: true, padding: 18 },
        },
        tooltip: {
          backgroundColor: "#24241f",
          titleColor: "#fff8ee",
          bodyColor: "#fff8ee",
          padding: 12,
        },
      },
      ...(type === "doughnut"
        ? { cutout: "72%" }
        : {
            scales: {
              x: {
                stacked: type === "bar",
                grid: { display: false },
                ticks: {
                  maxRotation: 0,
                  maxTicksLimit: timeline ? 7 : 8,
                  precision: 0,
                },
              },
              y: {
                stacked: type === "bar",
                beginAtZero: true,
                ticks: { precision: 0 },
                grid: { display: !horizontal },
              },
            },
          }),
    },
  });
  instances.set(target, plot);
  if (timeline) {
    const toolbar = document.createElement("div");
    toolbar.className = "chart-controls";
    for (const [label, days] of [
      ["Zoom to last 7 days", 7],
      ["Reset view", labels.length],
    ]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => {
        plot.options.scales.x.min = Math.max(0, labels.length - days);
        plot.options.scales.x.max = labels.length - 1;
        plot.update();
      });
      toolbar.append(button);
    }
    target.append(toolbar);
  }
  const details = document.createElement("details");
  details.className = "chart-data";
  const summary = document.createElement("summary");
  summary.textContent = "View chart data";
  details.append(summary);
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["Label", ...datasets.map((d) => d.label)]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  labels.forEach((label, i) => {
    const row = document.createElement("tr");
    for (const value of [label, ...datasets.map((d) => d.data[i])]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    }
    table.append(row);
  });
  details.append(table);
  target.append(details);
}
