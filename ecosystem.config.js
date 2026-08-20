module.exports = {
  apps: [
    {
      name: "cooperative-api",
      script: "Server/app.js",
      instances: "max", // Utilize all available CPU cores
      exec_mode: "cluster",
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};