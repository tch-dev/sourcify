import React from "react";

const Footer: React.FC = () => {
    return (
        <footer className="footer">
            <p>Sourcify Team • {new Date().getFullYear()} • trustcontract.dev </p>
        </footer>
    );
};

export default Footer;
