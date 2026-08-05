exports.getLogin = (req, res) => {
  res.render("auth/index", { config: req.app.get('APP_CONFIG') });
};


exports.getAvailableFonts = async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const fontsDir = path.join(__dirname, '..', 'views', 'shared', 'styles', 'fonts');
    const fontsCssPath = path.join(__dirname, '..', 'views', 'shared', 'styles', 'fonts.css');

    try {
        let files = [];
        try {
            const dirFiles = await fs.promises.readdir(fontsDir);
            files = dirFiles.filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f));
        } catch(e) {
            // Ignore if directory does not exist
        }

        let cssVariables = [];
        try {
            const content = await fs.promises.readFile(fontsCssPath, 'utf8');
            const matches = content.match(/--font-family-[a-zA-Z0-9-]+/g);
            if (matches) {
                cssVariables = [...new Set(matches)];
            }
        } catch(e) {
            // Ignore if file does not exist
        }

        res.json({ files, cssVariables });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to load fonts" });
    }
};
