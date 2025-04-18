// CARA JALANIN: 1. MASUKIN KEY DI .ENV (kecuali yg supabase)
// 2. MASUKIN CLIENT_SECRET.JSON DI CONFIG
// 3. JALANIN INDEX.JS, COMMAND : node src/index.js
// 4. BUKA BROWSER, BUKA localhost:3000
// 5. KLIK LOGIN DENGAN GOOGLE, DAN SELESAI

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const https = require("https");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@supabase/supabase-js");

const credentialsPath = path.join(__dirname, "config", "client_secret.json");
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));

// Initialize Prisma client
const prisma = new PrismaClient();

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "..", "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Function to download and save profile picture
async function downloadProfilePicture(url, userId) {
    return new Promise((resolve, reject) => {
        const fileName = `profile-${userId}.jpg`;
        const filePath = path.join(uploadsDir, fileName);

        // Check if file already exists
        if (fs.existsSync(filePath)) {
            resolve(`/uploads/${fileName}`);
            return;
        }

        https
            .get(url, response => {
                if (response.statusCode !== 200) {
                    reject(
                        new Error(
                            `Failed to download image: ${response.statusCode}`
                        )
                    );
                    return;
                }

                const fileStream = fs.createWriteStream(filePath);
                response.pipe(fileStream);

                fileStream.on("finish", () => {
                    fileStream.close();
                    resolve(`/uploads/${fileName}`);
                });

                fileStream.on("error", err => {
                    fs.unlink(filePath, () => reject(err));
                });
            })
            .on("error", reject);
    });
}

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
    session({
        secret: process.env.SESSION_SECRET || "default-secret",
        resave: false,
        saveUninitialized: true,
    })
);

// Initialize passport
app.use(passport.initialize());
app.use(passport.session());

// Configure Google OAuth strategy
passport.use(
    new GoogleStrategy(
        {
            clientID: credentials.web.client_id,
            clientSecret: credentials.web.client_secret,
            callbackURL: "/auth/google/callback",
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                // Log user information
                console.log("\n=== User Login ===");
                console.log("Email:", profile.emails[0].value);
                console.log("Name:", profile.displayName);
                console.log("Google ID:", profile.id);
                console.log("================\n");

                // Download profile picture
                const localAvatarUrl = await downloadProfilePicture(
                    profile.photos[0].value,
                    profile.id
                );

                // Check if user exists in Supabase
                const { data: existingUser, error: fetchError } = await supabase
                    .from("users")
                    .select()
                    .eq("google_id", profile.id)
                    .single();

                if (fetchError && fetchError.code !== "PGRST116") {
                    console.error("Supabase fetch error:", fetchError);
                } else if (existingUser) {
                    return done(null, {
                        ...existingUser,
                        avatar_url: localAvatarUrl,
                    });
                }

                // Create new user if doesn't exist
                const { data: newUser, error: insertError } = await supabase
                    .from("users")
                    .insert([
                        {
                            google_id: profile.id,
                            email: profile.emails[0].value,
                            full_name: profile.displayName,
                            avatar_url: localAvatarUrl,
                        },
                    ])
                    .select()
                    .single();

                if (insertError) {
                    console.error("Supabase insert error:", insertError);
                } else if (newUser) {
                    return done(null, newUser);
                }

                // Fallback to basic profile data if Supabase fails
                const basicProfile = {
                    google_id: profile.id,
                    email: profile.emails[0].value,
                    full_name: profile.displayName,
                    avatar_url: localAvatarUrl,
                };
                return done(null, basicProfile);
            } catch (error) {
                console.error("Error in Google Strategy:", error);
                return done(error);
            }
        }
    )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Routes
app.get("/", (req, res) =>
    res.send('<a href="/auth/google">Login with Google</a>')
);

app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => {
        // Log user information to terminal
        console.log("\n=== New User Login ===");
        console.log("Email:", req.user.email);
        console.log("Name:", req.user.full_name);
        console.log("Google ID:", req.user.google_id);
        console.log("===================\n");

        res.redirect("/profile");
    }
);

app.get("/profile", async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect("/");
    }

    try {
        let userData = req.user;

        // Try to fetch latest user data
        const { data, error } = await supabase
            .from("users")
            .select("*")
            .eq("google_id", req.user.google_id)
            .single();

        if (!error && data) {
            userData = data;
        }

        res.send(`
      <h1>Welcome ${userData.full_name}</h1>
      <img src="${userData.avatar_url}" alt="Profile picture" style="width: 100px; border-radius: 50%;">
      <p>Email: ${userData.email}</p>
      <a href="/logout">Logout</a>
    `);
    } catch (error) {
        console.error("Error fetching user data:", error);
        res.status(500).send("Error fetching user data");
    }
});

app.get("/logout", (req, res) => {
    req.logout(() => {
        res.redirect("/");
    });
});

// Prisma routes
app.get("/users", async (req, res) => {
    try {
        const users = await prisma.user.findMany();
        res.json(users);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

app.post("/users", async (req, res) => {
    try {
        const { name, email } = req.body;
        const newUser = await prisma.user.create({
            data: { name, email },
        });
        res.json(newUser);
    } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ error: "Failed to create user" });
    }
});

// Basic Auth Routes
app.post("/auth/register", async (req, res) => {
    try {
        const { email, password, full_name } = req.body;

        if (!email || !password || !full_name) {
            return res
                .status(400)
                .json({ error: "Email, password, and full name are required" });
        }

        // Register user with Supabase
        const { data: authData, error: authError } = await supabase.auth.signUp(
            {
                email,
                password,
            }
        );

        if (authError) {
            console.error("Registration error:", authError);
            return res.status(400).json({ error: authError.message });
        }

        // Store additional user data in your users table
        const { data: userData, error: userError } = await supabase
            .from("users")
            .insert([
                {
                    email,
                    full_name,
                    auth_id: authData.user.id,
                },
            ])
            .select();

        if (userError) {
            console.error("User data error:", userError);
            return res.status(400).json({ error: userError.message });
        }

        console.log("\n=== New User Registration ===");
        console.log("Email:", email);
        console.log("Name:", full_name);
        console.log("=========================\n");

        res.json({
            message: "Registration successful",
            user: userData[0],
        });
    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res
                .status(400)
                .json({ error: "Email and password are required" });
        }

        // Sign in with Supabase
        const { data: authData, error: authError } =
            await supabase.auth.signInWithPassword({
                email,
                password,
            });

        if (authError) {
            console.error("Login error:", authError);
            return res.status(400).json({ error: authError.message });
        }

        // Get user data from your users table
        const { data: userData, error: userError } = await supabase
            .from("users")
            .select("*")
            .eq("auth_id", authData.user.id)
            .single();

        if (userError) {
            console.error("User data error:", userError);
            return res.status(400).json({ error: userError.message });
        }

        console.log("\n=== User Login ===");
        console.log("Email:", email);
        console.log("Name:", userData.full_name);
        console.log("================\n");

        // Set session
        req.session.user = userData;

        res.json({
            message: "Login successful",
            user: userData,
        });
    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/auth/logout", (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ error: "Failed to logout" });
        }
        res.json({ message: "Logout successful" });
    });
});

// Protected route example
app.get("/protected", (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    res.json({ message: "This is a protected route", user: req.session.user });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
    console.log(`Server running on http://localhost:${PORT}`)
);

module.exports = app;
