import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Train } from "lucide-react";

const Register = () => {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await signUp(username, password, fullName, email);
    setLoading(false);
    if (error) toast({ title: "Registration Failed", description: error.message, variant: "destructive" });
    else navigate("/");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 railway-gradient">
      <Card className="w-full max-w-md bg-card border-border">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 rounded-xl railway-gradient flex items-center justify-center">
            <Train className="h-7 w-7 text-primary-foreground" />
          </div>
          <CardTitle className="text-xl text-foreground">Create Account</CardTitle>
          <p className="text-sm text-muted-foreground">Register for NVR system access (VIEWER role)</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><Label>Full Name</Label><Input placeholder="Rajesh Kumar" value={fullName} onChange={(e) => setFullName(e.target.value)} required /></div>
            <div><Label>Username</Label><Input placeholder="rajesh.kumar" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" /></div>
            <div><Label>Email (optional)</Label><Input type="email" placeholder="operator@railway.gov.in" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div><Label>Password</Label><Input type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" /></div>
            <Button type="submit" className="w-full" disabled={loading}>{loading ? "Creating account..." : "Create Account"}</Button>
            <div className="text-center">
              <Link to="/login" className="text-xs text-primary hover:underline">Already have an account? Sign in</Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
export default Register;
