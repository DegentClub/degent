'use client';

export default function AIInstructions() {
  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = '/Degen.jpg';
    link.download = 'Degen.jpg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div id="instructions-section" className="degent-card">
      <h2 className="degent-title h2">
        <span className="icon-square">
          <i className="fas fa-palette text-degent-green"></i>
        </span>
        <span><strong>Create</strong> Your Decentralized Gentleman</span>
      </h2>
      
        <div className="degent-card-2 text-degent-muted">
          <h3 className="degent-title h3">
            <span className="icon-square">
              <i className="fas fa-list-check text-degent-green text-sm"></i>
            </span>
            Image Requirements:
          </h3>
          <ul className="degent-list">
            <li className="item">
              <i className="fas fa-check"></i>
              <span>Must be Pepe in a tuxedo</span>
            </li>
            <li className="item">
              <i className="fas fa-vest"></i>
              <span>Bowtie is <strong className="text-white">mandatory</strong></span>
            </li>
            <li className="item">
              <i className="fas fa-font"></i>
              <span>Must include text: &ldquo;DEGEN&rdquo;, &ldquo;DEGENT&rdquo;, or &ldquo;REGEN&rdquo;</span>
            </li>
          </ul>
        </div>

        <div className="degent-card-2">
          <h3 className="degent-title h3">
            <span className="icon-square">
              <i className="fas fa-magic text-degent-green text-sm"></i>
            </span>
            How to Generate:
          </h3>
          <ol className="degent-list">
            <li className="item">
              <span className="text-degent-green font-bold">1.</span>
              <span>Use any AI image generator (ChatGPT, Midjourney, etc.)</span>
            </li>
            <li className="item">
              <span className="text-degent-green font-bold">2.</span>
              <span>Download our sample image below as reference</span>
            </li>
            <li className="item">
              <span className="text-degent-green font-bold">3.</span>
              <span>Prompt: &ldquo;Make one like this&rdquo;</span>
            </li>
          </ol>
        </div>

        <div className="degent-row">
          <div className="degent-card-col half">
            <img 
              src="/Degen.jpg" 
              alt="Sample Degent" 
              className="degent-image square w-48"
              style={{
                boxShadow: '8px 8px 0px 0px #00000040'
              }}
            />
            <div className="flex-grow flex flex-col justify-evenly items-center">
              <p className="text-sm text-degent-muted mb-4">Sample Degent image for reference</p>
              <button
                onClick={handleDownload}
                className="btn btn-flex btn-gradient btn-curtain w-full"
              >
                <i className="fas fa-download"></i>
                <span>Download Sample</span>
              </button>
            </div>
          </div>
          <div className="degent-card-col half">
            <img 
              src="/template.png" 
              alt="Canva Template" 
              className="border border-degent-green/20 icon-square mx-auto object-cover rounded-degent-card w-48"
              style={{
                backgroundColor: '#2d3730',
                backgroundImage: 'linear-gradient(to top right, #161617b5, #02b15b87)',
                boxShadow: '8px 8px 0px 0px #00000040'
              }}
            />
            <div className="flex-grow flex flex-col justify-evenly items-center">
              <p className="text-sm text-degent-muted mb-4">Edit the official Canva template</p>
              <a
                href="https://www.canva.com/design/DAGmbO5kaP4/DSXgcMcw540zRAkTF9M_Lw/edit"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-flex btn-gradient btn-curtain w-full"
              >
                <i className="fa-solid fa-arrow-up-right-from-square"></i>
                <span>Open Template</span>
              </a>
            </div>
          </div>
        </div>
    </div>
  );
}
